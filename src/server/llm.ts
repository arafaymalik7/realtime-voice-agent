// llm.ts — transcript + history in, streamed text tokens out.
// Implementation: Google Gemini via the official @google/genai SDK.
// Model: gemini-3.1-flash-lite — measured ~600 ms first token on the free tier;
// gemini-3.5-flash measured 6-18 s (thinking pipeline) and the 2.5 models are
// retired for new API keys. History is kept client-side (this model is not
// served by the Interactions API).
// Provider-swappable: keep everything Gemini-specific behind LlmClient.

import { GoogleGenAI, Content } from "@google/genai";

export interface LlmError {
  source: "llm";
  code: string;
  message: string;
}

export interface LlmEvents {
  /** Fired once, on the first text delta. latencyMs = request send -> first token. */
  onFirstToken: (latencyMs: number) => void;
  onDelta: (text: string) => void;
  onDone: (fullText: string) => void;
  onError: (e: LlmError) => void;
}

const SYSTEM_INSTRUCTION =
  "You are a friendly voice assistant on a phone-style call. " +
  "Reply in short, natural spoken sentences — no markdown, no lists, no emoji. " +
  "Be concise: one or two sentences unless the caller asks for more.";

const MAX_HISTORY_TURNS = 20; // user+model messages kept for context

export class LlmClient {
  private ai: GoogleGenAI;
  private history: Content[] = [];

  constructor(apiKey: string, private model: string = "gemini-3.1-flash-lite") {
    this.ai = new GoogleGenAI({ apiKey });
  }

  /**
   * Pre-establish DNS + TLS + HTTP/2 to the API origin with a cheap metadata
   * call, so the first real request doesn't pay ~300 ms connection setup.
   */
  warmup(): void {
    void this.ai.models.get({ model: this.model }).catch(() => {
      /* warmup is best-effort; real errors surface on the first respond() */
    });
  }

  /**
   * Stream a reply to userText. Aborts cleanly when `signal` fires: the loop
   * stops consuming and the aborted exchange is not committed to history.
   */
  async respond(userText: string, events: LlmEvents, signal?: AbortSignal): Promise<void> {
    const sentAt = Date.now();
    let firstToken = true;
    let fullText = "";
    const contents: Content[] = [...this.history, { role: "user", parts: [{ text: userText }] }];

    try {
      const stream = await this.ai.models.generateContentStream({
        model: this.model,
        contents,
        config: {
          systemInstruction: SYSTEM_INSTRUCTION,
          abortSignal: signal,
        },
      });

      for await (const chunk of stream) {
        if (signal?.aborted) return; // barge-in: stop; do not commit history
        const text = chunk.text;
        if (text) {
          if (firstToken) {
            firstToken = false;
            events.onFirstToken(Date.now() - sentAt);
          }
          fullText += text;
          events.onDelta(text);
        }
      }

      if (signal?.aborted) return;
      this.history.push({ role: "user", parts: [{ text: userText }] });
      this.history.push({ role: "model", parts: [{ text: fullText }] });
      if (this.history.length > MAX_HISTORY_TURNS) {
        this.history = this.history.slice(-MAX_HISTORY_TURNS);
      }
      events.onDone(fullText);
    } catch (err) {
      if (signal?.aborted) return; // aborted mid-request; not an error
      const message = err instanceof Error ? err.message : String(err);
      events.onError({ source: "llm", code: "REQUEST_FAILED", message });
    }
  }
}
