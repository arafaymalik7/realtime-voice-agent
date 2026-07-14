// stt.ts — audio frames in, transcript + end-of-turn events out.
// Implementation: Deepgram Flux (wss://api.deepgram.com/v2/listen).
// Swappable: keep everything Deepgram-specific behind SttSession/SttEvents.

import { WebSocket } from "ws";

export interface TurnEvent {
  /** Flux event: Update | StartOfTurn | EagerEndOfTurn | TurnResumed | EndOfTurn */
  event: string;
  transcript: string;
  turnIndex: number;
  /** End of the last transcribed word, seconds on the audio timeline. */
  lastWordEnd: number | null;
  endOfTurnConfidence: number | null;
}

export interface SttError {
  source: "stt";
  code: string;
  message: string;
}

export interface SttEvents {
  onOpen: () => void;
  onTurn: (t: TurnEvent) => void;
  onError: (e: SttError) => void;
  onClose: () => void;
}

const FLUX_URL = "wss://api.deepgram.com/v2/listen";
const CONNECT_TIMEOUT_MS = 5_000;

export class SttSession {
  private ws: WebSocket | null = null;
  private queue: Buffer[] = [];
  private open = false;
  private closed = false;
  private connectTimer: NodeJS.Timeout | null = null;

  constructor(
    private apiKey: string,
    private events: SttEvents,
    private opts: {
      model?: string;
      sampleRate?: number;
      eotThreshold?: number;
      eagerEotThreshold?: number;
    } = {}
  ) {}

  connect(): void {
    const params = new URLSearchParams({
      model: this.opts.model ?? "flux-general-en",
      encoding: "linear16",
      sample_rate: String(this.opts.sampleRate ?? 16000),
      eot_threshold: String(this.opts.eotThreshold ?? 0.7),
    });
    if (this.opts.eagerEotThreshold !== undefined) {
      params.set("eager_eot_threshold", String(this.opts.eagerEotThreshold));
    }

    this.ws = new WebSocket(`${FLUX_URL}?${params.toString()}`, {
      headers: { Authorization: `Token ${this.apiKey}` },
    });

    this.connectTimer = setTimeout(() => {
      if (!this.open && !this.closed) {
        this.events.onError({
          source: "stt",
          code: "CONNECT_TIMEOUT",
          message: `Deepgram connection not established within ${CONNECT_TIMEOUT_MS}ms`,
        });
        this.ws?.terminate();
      }
    }, CONNECT_TIMEOUT_MS);

    this.ws.on("open", () => {
      if (this.connectTimer) clearTimeout(this.connectTimer);
      this.open = true;
      for (const buf of this.queue) this.ws!.send(buf);
      this.queue = [];
      this.events.onOpen();
    });

    this.ws.on("message", (raw) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        this.events.onError({ source: "stt", code: "BAD_JSON", message: "unparseable message from Deepgram" });
        return;
      }
      if (msg.type === "TurnInfo") {
        const words = (msg.words as Array<{ end: number }> | undefined) ?? [];
        this.events.onTurn({
          event: String(msg.event),
          transcript: String(msg.transcript ?? ""),
          turnIndex: Number(msg.turn_index ?? 0),
          lastWordEnd: words.length > 0 ? words[words.length - 1].end : null,
          endOfTurnConfidence:
            typeof msg.end_of_turn_confidence === "number" ? msg.end_of_turn_confidence : null,
        });
      } else if (msg.type === "Error") {
        this.events.onError({
          source: "stt",
          code: String(msg.code ?? "UNKNOWN"),
          message: String(msg.description ?? "Deepgram fatal error"),
        });
      }
      // Connected / ConfigureSuccess: no action needed.
    });

    this.ws.on("error", (err) => {
      this.events.onError({ source: "stt", code: "WS_ERROR", message: err.message });
    });

    this.ws.on("close", (code) => {
      this.open = false;
      if (!this.closed) {
        this.closed = true;
        this.events.onClose();
      }
      void code;
    });

    this.ws.on("unexpected-response", (_req, res) => {
      this.events.onError({
        source: "stt",
        code: `HTTP_${res.statusCode}`,
        message: `Deepgram rejected connection (HTTP ${res.statusCode})`,
      });
    });
  }

  sendAudio(frame: Buffer): void {
    if (this.closed) return;
    if (this.open && this.ws) {
      this.ws.send(frame);
    } else {
      this.queue.push(frame);
      if (this.queue.length > 400) this.queue.shift(); // cap ~20s of buffered audio
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.connectTimer) clearTimeout(this.connectTimer);
    if (this.open && this.ws) {
      try {
        this.ws.send(JSON.stringify({ type: "CloseStream" }));
      } catch {
        /* socket already dying */
      }
    }
    this.ws?.close();
  }
}
