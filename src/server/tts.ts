// tts.ts — text in, audio frames out; single swappable interface.
// Implementation: ElevenLabs streaming WebSocket (stream-input),
// model eleven_flash_v2_5, raw PCM 16 kHz out (no decode latency; instantly
// stoppable playback for barge-in).
// One TtsStream per agent reply: open it when the LLM request is sent so the
// connection handshake overlaps LLM inference.

import { WebSocket } from "ws";

export interface TtsError {
  source: "tts";
  code: string;
  message: string;
}

export interface TtsEvents {
  /** Raw 16 kHz 16-bit mono PCM. */
  onAudio: (pcm: Buffer) => void;
  onDone: () => void;
  onError: (e: TtsError) => void;
}

const TTS_MODEL = "eleven_flash_v2_5";
const OUTPUT_FORMAT = "pcm_16000";
const FIRST_AUDIO_TIMEOUT_MS = 10_000;

export class TtsStream {
  private ws: WebSocket;
  private open = false;
  private closed = false;
  private pendingText: string[] = [];
  private endRequested = false;
  private gotAudio = false;
  private timeout: NodeJS.Timeout | null = null;

  constructor(
    apiKey: string,
    voiceId: string,
    private events: TtsEvents
  ) {
    const url =
      `wss://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream-input` +
      `?model_id=${TTS_MODEL}&output_format=${OUTPUT_FORMAT}`;

    this.ws = new WebSocket(url, { headers: { "xi-api-key": apiKey } });

    this.ws.on("open", () => {
      this.open = true;
      // Handshake: settings + aggressive chunk schedule for low first-byte latency.
      this.ws.send(
        JSON.stringify({
          text: " ",
          voice_settings: { stability: 0.5, similarity_boost: 0.8 },
          generation_config: { chunk_length_schedule: [50, 90, 120, 150] },
        })
      );
      for (const t of this.pendingText) this.sendChunk(t);
      this.pendingText = [];
      if (this.endRequested) this.sendEnd();
    });

    this.ws.on("message", (raw) => {
      let msg: { audio?: string; isFinal?: boolean | null; error?: string; message?: string };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        this.fail("BAD_JSON", "unparseable message from ElevenLabs");
        return;
      }
      if (msg.error) {
        this.fail(String(msg.error), String(msg.message ?? "ElevenLabs error"));
        return;
      }
      if (msg.audio) {
        if (!this.gotAudio) {
          this.gotAudio = true;
          this.clearTimer();
        }
        this.events.onAudio(Buffer.from(msg.audio, "base64"));
      }
      if (msg.isFinal === true) {
        this.finish();
      }
    });

    this.ws.on("close", () => this.finish());
    this.ws.on("error", (err) => this.fail("WS_ERROR", err.message));
    this.ws.on("unexpected-response", (_req, res) => {
      this.fail(
        `HTTP_${res.statusCode}`,
        `ElevenLabs rejected connection (HTTP ${res.statusCode})`
      );
    });

    this.timeout = setTimeout(() => {
      if (!this.gotAudio) this.fail("TIMEOUT", `no audio within ${FIRST_AUDIO_TIMEOUT_MS}ms`);
    }, FIRST_AUDIO_TIMEOUT_MS);
  }

  /** Feed a piece of reply text (LLM delta). */
  sendText(text: string): void {
    if (this.closed || this.endRequested) return;
    if (this.open) this.sendChunk(text);
    else this.pendingText.push(text);
  }

  /** No more text: generate remaining audio, then finish. */
  end(): void {
    if (this.closed || this.endRequested) return;
    this.endRequested = true;
    if (this.open) this.sendEnd();
  }

  /** Hard stop (barge-in): kill the stream immediately, no onDone. */
  abort(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearTimer();
    this.ws.terminate();
  }

  private sendChunk(text: string): void {
    // Protocol: text messages should end with a single space.
    this.ws.send(JSON.stringify({ text: text.endsWith(" ") ? text : text + " " }));
  }

  private sendEnd(): void {
    this.ws.send(JSON.stringify({ text: "" })); // close message: flush + end generation
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearTimer();
    this.events.onDone();
    this.ws.close();
  }

  private fail(code: string, message: string): void {
    if (this.closed) return;
    this.closed = true;
    this.clearTimer();
    this.events.onError({ source: "tts", code, message });
    this.ws.terminate();
  }

  private clearTimer(): void {
    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }
  }
}
