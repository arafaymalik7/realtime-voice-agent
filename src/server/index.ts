import "dotenv/config";
import http from "http";
import fs from "fs";
import path from "path";
import crypto from "crypto";
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

// --- Security / abuse limits (Phase 8) ---
const SESSION_TOKEN_TTL_MS = 60_000; // token must be used within a minute
const MAX_CONNS_PER_IP = 3;
// Caps cost abuse per session. Set high relative to "conversational turns/min"
// because the eager-overlap turn design (Phase 5) fires a fresh LLM call on
// every incremental transcript update while the user is still talking — one
// spoken utterance with a couple of pauses can cost 3-5 calls before the user
// even finishes. A cap sized for "turns" (e.g. 20) throttles real conversation.
const LLM_CALLS_PER_MIN = 60;
const IDLE_TIMEOUT_MS = Number(process.env.IDLE_TIMEOUT_MS) || 5 * 60_000;
// Transcripts are user speech (PII). Only log them when explicitly enabled.
const DEBUG_TRANSCRIPTS = process.env.DEBUG_TRANSCRIPTS === "1";

function redact(text: string): string {
  return DEBUG_TRANSCRIPTS ? text : `[redacted ${text.length} chars]`;
}

// Short-lived single-use session tokens: fetched via GET /session by the page,
// required to open a WebSocket. Blocks drive-by WS connections.
const sessionTokens = new Map<string, number>(); // token -> expiry epoch ms
setInterval(() => {
  const now = Date.now();
  for (const [t, exp] of sessionTokens) if (exp < now) sessionTokens.delete(t);
}, 30_000).unref();

const connsPerIp = new Map<string, number>();

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

  if (url === "/session") {
    const origin = req.headers.origin ?? req.headers.referer;
    if (origin && ![...ALLOWED_ORIGINS].some((o) => String(origin).startsWith(o))) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }
    const token = crypto.randomBytes(24).toString("base64url");
    sessionTokens.set(token, Date.now() + SESSION_TOKEN_TTL_MS);
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ token }));
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
  verifyClient: ({ origin, req }: { origin?: string; req: http.IncomingMessage }) => {
    // 1. Origin allowlist
    if (origin && !ALLOWED_ORIGINS.has(origin)) {
      log(`WS rejected: bad origin ${origin}`);
      return false;
    }
    // 2. Short-lived single-use session token
    const token = new URL(req.url ?? "/", "http://x").searchParams.get("token") ?? "";
    const expiry = sessionTokens.get(token);
    if (!expiry || expiry < Date.now()) {
      log("WS rejected: missing/expired session token");
      return false;
    }
    sessionTokens.delete(token); // single-use
    // 3. Concurrent connections per IP
    const ip = req.socket.remoteAddress ?? "unknown";
    if ((connsPerIp.get(ip) ?? 0) >= MAX_CONNS_PER_IP) {
      log(`WS rejected: too many connections from ${ip}`);
      return false;
    }
    return true;
  },
});

function sendJson(ws: WebSocket, obj: unknown): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

wss.on("connection", (ws: WebSocket, req: http.IncomingMessage) => {
  const ip = req.socket.remoteAddress ?? "unknown";
  connsPerIp.set(ip, (connsPerIp.get(ip) ?? 0) + 1);
  log("connected");

  // Idle timeout: no mic audio for IDLE_TIMEOUT_MS -> clean close.
  let lastActivityMs = Date.now();
  const idleTimer = setInterval(() => {
    if (Date.now() - lastActivityMs > IDLE_TIMEOUT_MS) {
      log("idle timeout — closing session");
      sendJson(ws, { type: "session_ended" });
      ws.close();
    }
  }, 30_000);

  // Per-session LLM rate limit (sliding window).
  const llmCallTimes: number[] = [];
  function allowLlmCall(): boolean {
    const now = Date.now();
    while (llmCallTimes.length > 0 && llmCallTimes[0] < now - 60_000) llmCallTimes.shift();
    if (llmCallTimes.length >= LLM_CALLS_PER_MIN) return false;
    llmCallTimes.push(now);
    return true;
  }

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
  // `sessionOver` is checked by the STT turn callback below: Deepgram can keep
  // delivering a few buffered TurnInfo events after we call stt.close() (the
  // WS close is async), and without this guard those late events would keep
  // driving the turn state machine — starting new Gemini/ElevenLabs calls
  // into a socket we've already ended the session on.
  let sessionOver = false;
  let failed = false;
  function failSession(e: { source: string; code: string; message: string }): void {
    if (failed) return;
    failed = true;
    sessionOver = true;
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
    allowReply: allowLlmCall,
    redact,
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
          if (sessionOver) return; // late-arriving event after the session ended — ignore
          sendJson(ws, { type: "stt", event: t.event, transcript: t.transcript, turnIndex: t.turnIndex });

          const speechEndWallMs =
            t.lastWordEnd !== null && lastFrameWallMs > 0 ? Math.round(wallAt(t.lastWordEnd)) : null;

          if (t.event === "EndOfTurn" || t.event === "EagerEndOfTurn") {
            let gapMs: number | null = null;
            if (speechEndWallMs !== null) gapMs = Math.round(Date.now() - speechEndWallMs);
            log(
              `stt: ${t.event} turn=${t.turnIndex} conf=${t.endOfTurnConfidence?.toFixed(2)} ` +
                `gap=${gapMs !== null ? gapMs + "ms" : "n/a"} transcript="${redact(t.transcript)}"`
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
    if (sessionOver) return; // draining while the close timer runs — ignore
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
      lastActivityMs = lastFrameWallMs;
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
    sessionOver = true;
    clearInterval(idleTimer);
    const n = (connsPerIp.get(ip) ?? 1) - 1;
    if (n <= 0) connsPerIp.delete(ip);
    else connsPerIp.set(ip, n);
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
