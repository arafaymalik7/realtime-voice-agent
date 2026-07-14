import "dotenv/config";
import http from "http";
import fs from "fs";
import path from "path";
import { WebSocketServer, WebSocket } from "ws";
import { SttSession, TurnEvent, SttError } from "./stt";
import { LlmClient } from "./llm";
import { createToolSet } from "./tools";
import { TtsStream } from "./tts";
import { TurnManager } from "./turn";
import { initFallback, getFallbackAudio, FALLBACK_LINE } from "./fallback";

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.resolve(__dirname, "..", "..", "public");
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY ?? "";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? "";
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY ?? "";
const TTS_VOICE_ID = process.env.TTS_VOICE_ID ?? "EXAVITQu4vr4xnSDxMaL"; // Sarah (premade)

// Endpointing (tuned Phase 5): final threshold high so real pauses don't cut the
// user off; eager threshold low so replies start early (voided on TurnResumed).
const EOT_THRESHOLD = 0.7;
const EAGER_EOT_THRESHOLD = 0.4;

// Origins allowed to open a WebSocket. Localhost only for now; revisit in Phase 8.
const ALLOWED_ORIGINS = new Set([
  `http://localhost:${PORT}`,
  `http://127.0.0.1:${PORT}`,
]);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".ico": "image/x-icon",
};

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

const server = http.createServer((req, res) => {
  const url = req.url ?? "/";

  if (url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  const relPath = url === "/" ? "index.html" : url.replace(/^\/+/, "");
  const filePath = path.resolve(PUBLIC_DIR, relPath);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== PUBLIC_DIR) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] ?? "application/octet-stream" });
    res.end(data);
  });
});

const wss = new WebSocketServer({
  server,
  maxPayload: 1024 * 1024, // 1 MiB cap on inbound messages
  verifyClient: ({ origin }: { origin?: string }) => {
    if (!origin || ALLOWED_ORIGINS.has(origin)) return true;
    log(`WS rejected: bad origin ${origin}`);
    return false;
  },
});

function sendJson(ws: WebSocket, obj: unknown): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

wss.on("connection", (ws: WebSocket) => {
  log("connected");

  let stt: SttSession | null = null;
  let sttOpen = false;
  let frames = 0;
  let droppedPreOpen = 0;
  // Audio-position accounting: maps Deepgram's audio timeline to wall clock even
  // when the mic pauses (stop/start) — cumulative audio forwarded, not a fixed epoch.
  const BYTES_PER_SEC = 16000 * 2; // 16 kHz, 16-bit mono
  let audioForwardedSec = 0;
  let lastFrameWallMs = 0;

  /** Wall-clock ms at which audio-timeline position `posSec` was captured. */
  function wallAt(posSec: number): number {
    return lastFrameWallMs - (audioForwardedSec - posSec) * 1000;
  }

  // --- Safe failure: speak the cached fallback line and end the session ---
  let failed = false;
  function failSession(e: { source: string; code: string; message: string }): void {
    if (failed) return;
    failed = true;
    log(`FATAL ${JSON.stringify(e)} — speaking fallback and ending session`);

    // Silence the pipeline first so nothing races the fallback audio.
    stt?.close();
    stt = null;
    turn.onDisconnect();

    const fb = getFallbackAudio();
    sendJson(ws, {
      type: "fatal",
      ...e,
      fallbackLine: fb && !fb.isTone ? FALLBACK_LINE : null,
    });
    let waitMs = 500;
    if (fb && ws.readyState === WebSocket.OPEN) {
      ws.send(fb.pcm);
      waitMs = fb.durationMs + 750;
    }
    setTimeout(() => {
      sendJson(ws, { type: "session_ended" });
      ws.close();
      log("session ended cleanly after fatal error");
    }, waitMs);
  }

  // --- Turn manager: owns the reply lifecycle and the state machine ---
  const llm = GEMINI_API_KEY ? new LlmClient(GEMINI_API_KEY, createToolSet()) : null;
  llm?.warmup(); // pre-establish the HTTPS connection while the user is still silent

  const turn = new TurnManager({
    llm,
    createTts: (events) => {
      if (!ELEVENLABS_API_KEY) {
        failSession({ source: "tts", code: "NO_API_KEY", message: "ELEVENLABS_API_KEY not set" });
        return null;
      }
      return new TtsStream(ELEVENLABS_API_KEY, TTS_VOICE_ID, events);
    },
    sendJson: (obj) => sendJson(ws, obj),
    sendAudio: (pcm) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(pcm);
    },
    log,
    onFatal: failSession,
  });

  function startStt(): void {
    if (!DEEPGRAM_API_KEY) {
      failSession({ source: "stt", code: "NO_API_KEY", message: "DEEPGRAM_API_KEY not set" });
      return;
    }
    stt = new SttSession(
      DEEPGRAM_API_KEY,
      {
        onOpen: () => {
          sttOpen = true;
          log("stt: Deepgram Flux connected");
        },
        onTurn: (t: TurnEvent) => {
          sendJson(ws, { type: "stt", event: t.event, transcript: t.transcript, turnIndex: t.turnIndex });

          const speechEndWallMs =
            t.lastWordEnd !== null && lastFrameWallMs > 0 ? Math.round(wallAt(t.lastWordEnd)) : null;

          if (t.event === "EndOfTurn" || t.event === "EagerEndOfTurn") {
            let gapMs: number | null = null;
            if (speechEndWallMs !== null) gapMs = Math.round(Date.now() - speechEndWallMs);
            log(
              `stt: ${t.event} turn=${t.turnIndex} conf=${t.endOfTurnConfidence?.toFixed(2)} ` +
                `gap=${gapMs !== null ? gapMs + "ms" : "n/a"} transcript="${t.transcript}"`
            );
            if (t.event === "EagerEndOfTurn") {
              turn.onEagerEndOfTurn(t.transcript, speechEndWallMs);
            } else {
              sendJson(ws, { type: "metric", name: "eot_gap_ms", value: gapMs });
              turn.onEndOfTurn(t.transcript, speechEndWallMs);
            }
          } else if (t.event === "TurnResumed") {
            log(`stt: TurnResumed turn=${t.turnIndex}`);
            turn.onTurnResumed();
          } else if (t.event === "StartOfTurn") {
            log(`stt: StartOfTurn turn=${t.turnIndex}`);
            turn.onStartOfTurn();
          }
        },
        onError: (e: SttError) => {
          log(`ERROR ${JSON.stringify(e)}`);
          failSession(e);
        },
        onClose: () => {
          log("stt: Deepgram connection closed");
          // Unexpected close while the mic is actively streaming = transcription
          // is dead mid-conversation. A close after idle (mic stopped) is benign.
          if (!failed && lastFrameWallMs > 0 && Date.now() - lastFrameWallMs < 10_000) {
            failSession({
              source: "stt",
              code: "CONNECTION_LOST",
              message: "Deepgram closed the connection mid-conversation",
            });
          }
        },
      },
      { eotThreshold: EOT_THRESHOLD, eagerEotThreshold: EAGER_EOT_THRESHOLD }
    );
    stt.connect();
  }

  // Pre-warm STT at connection time so Deepgram is ready before speech starts.
  startStt();

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      // Drop audio until Flux is open — keeps Deepgram's audio timeline aligned
      // with wall clock (first forwarded frame = timeline t=0).
      if (!sttOpen || !stt) {
        droppedPreOpen++;
        return;
      }
      if (frames === 0 && droppedPreOpen > 0) {
        log(`audio: dropped ${droppedPreOpen} frames before stt open`);
      }
      frames++;
      audioForwardedSec += (data as Buffer).length / BYTES_PER_SEC;
      lastFrameWallMs = Date.now();
      stt.sendAudio(data as Buffer);
      if (frames % 200 === 0) log(`audio: ${frames} frames forwarded to stt`);
      return;
    }

    // Validate inbound text messages; reject unknown types (no trust in client JSON).
    let msg: { type?: unknown; [k: string]: unknown };
    try {
      msg = JSON.parse((data as Buffer).toString());
    } catch {
      log("WS invalid JSON from client — ignored");
      return;
    }
    if (msg.type === "barge_in") {
      turn.onClientBargeIn();
    } else if (msg.type === "client_metric" && typeof msg.name === "string" && typeof msg.value === "number") {
      log(`client metric: ${msg.name}=${msg.value}ms`);
    } else {
      log(`WS unknown message type "${String(msg.type)}" — rejected`);
    }
  });

  ws.on("close", () => {
    stt?.close();
    stt = null;
    turn.onDisconnect();
    log(`disconnected (forwarded ${frames} audio frames)`);
  });
  ws.on("error", (err) => log(`WS error: ${err.message}`));
});

void initFallback(ELEVENLABS_API_KEY, TTS_VOICE_ID).then(() => {
  const fb = getFallbackAudio();
  log(`fallback audio cached: ${fb ? (fb.isTone ? "tone (TTS unavailable)" : `spoken line, ${fb.durationMs}ms`) : "none"}`);
});

server.listen(PORT, () => {
  log(`Server listening on http://localhost:${PORT}`);
  const missing = ["DEEPGRAM_API_KEY", "GEMINI_API_KEY", "ELEVENLABS_API_KEY"].filter(
    (k) => !process.env[k]
  );
  if (missing.length > 0) {
    log(`Note: missing env keys: ${missing.join(", ")}`);
  }
});
