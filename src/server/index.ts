import "dotenv/config";
import http from "http";
import fs from "fs";
import path from "path";
import { WebSocketServer, WebSocket } from "ws";

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.resolve(__dirname, "..", "..", "public");

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

  // Static files from public/, with path-traversal protection.
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

wss.on("connection", (ws: WebSocket) => {
  log("connected");

  ws.on("message", (data, isBinary) => {
    // Phase 0: just acknowledge presence of traffic. Audio handling comes in Phase 1.
    log(`WS message received (${isBinary ? "binary" : "text"}, ${(data as Buffer).length} bytes)`);
  });

  ws.on("close", () => log("disconnected"));
  ws.on("error", (err) => log(`WS error: ${err.message}`));
});

server.listen(PORT, () => {
  log(`Server listening on http://localhost:${PORT}`);
  const missing = ["DEEPGRAM_API_KEY", "ANTHROPIC_API_KEY", "ELEVENLABS_API_KEY"].filter(
    (k) => !process.env[k]
  );
  if (missing.length > 0) {
    log(`Note: missing env keys (needed from Phase 2 onward): ${missing.join(", ")}`);
  }
});
