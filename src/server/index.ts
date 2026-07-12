import "dotenv/config";
import http from "http";
import fs from "fs";
import path from "path";
import { WebSocketServer, WebSocket } from "ws";
import { SttSession, TurnEvent, SttError } from "./stt";

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.resolve(__dirname, "..", "..", "public");
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY ?? "";

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

  function startStt(): void {
    if (!DEEPGRAM_API_KEY) {
      const err = { source: "stt", code: "NO_API_KEY", message: "DEEPGRAM_API_KEY not set" };
      log(`ERROR ${JSON.stringify(err)}`);
      sendJson(ws, { type: "error", ...err });
      return;
    }
    stt = new SttSession(DEEPGRAM_API_KEY, {
      onOpen: () => {
        sttOpen = true;
        log("stt: Deepgram Flux connected");
      },
      onTurn: (t: TurnEvent) => {
        sendJson(ws, { type: "stt", event: t.event, transcript: t.transcript, turnIndex: t.turnIndex });
        if (t.event === "EndOfTurn" || t.event === "EagerEndOfTurn") {
          // Gap between the end of the last spoken word (mapped to wall clock)
          // and this event's arrival = end-of-speech -> turn-signal latency.
          let gapMs: number | null = null;
          if (t.lastWordEnd !== null && lastFrameWallMs > 0) {
            gapMs = Math.round(Date.now() - wallAt(t.lastWordEnd));
          }
          log(
            `stt: ${t.event} turn=${t.turnIndex} conf=${t.endOfTurnConfidence?.toFixed(2)} ` +
              `gap=${gapMs !== null ? gapMs + "ms" : "n/a"} transcript="${t.transcript}"`
          );
          if (t.event === "EndOfTurn") {
            sendJson(ws, { type: "metric", name: "eot_gap_ms", value: gapMs });
          }
        } else if (t.event !== "Update") {
          log(`stt: ${t.event} turn=${t.turnIndex}`);
        }
      },
      onError: (e: SttError) => {
        log(`ERROR ${JSON.stringify(e)}`);
        sendJson(ws, { type: "error", ...e });
      },
      onClose: () => log("stt: Deepgram connection closed"),
    }, { eotThreshold: 0.5, eagerEotThreshold: 0.4 }); // eager events drive early LLM start (Phase 3+); re-tune in Phase 5
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
      if (frames % 100 === 0) log(`audio: ${frames} frames forwarded to stt`);
    } else {
      // Validate inbound text messages; reject unknown types (no trust in client JSON).
      log(`WS unexpected text message (${(data as Buffer).length}B) — ignored`);
    }
  });

  ws.on("close", () => {
    stt?.close();
    stt = null;
    log(`disconnected (forwarded ${frames} audio frames)`);
  });
  ws.on("error", (err) => log(`WS error: ${err.message}`));
});

server.listen(PORT, () => {
  log(`Server listening on http://localhost:${PORT}`);
  const missing = ["DEEPGRAM_API_KEY", "ANTHROPIC_API_KEY", "ELEVENLABS_API_KEY"].filter(
    (k) => !process.env[k]
  );
  if (missing.length > 0) {
    log(`Note: missing env keys: ${missing.join(", ")}`);
  }
});
