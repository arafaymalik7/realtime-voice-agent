// llm.ts — transcript + history in, streamed text tokens + tool calls out.
// Implementation: Google Gemini via the official @google/genai SDK.
// Model: gemini-3.1-flash-lite — measured ~600 ms first token on the free tier;
// gemini-3.5-flash measured 6-18 s (thinking pipeline) and the 2.5 models are
// retired for new API keys. History is kept client-side (this model is not
// served by the Interactions API).
// Provider-swappable: keep everything Gemini-specific behind LlmClient.

import { GoogleGenAI, Content, Part } from "@google/genai";
import { ToolSet } from "./tools";

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
  onToolCall?: (name: string, args: Record<string, unknown>) => void;
  onToolResult?: (name: string, result: Record<string, unknown>) => void;
}

function systemInstruction(): string {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const weekday = now.toLocaleDateString("en-US", { weekday: "long" });
  return (
    "You are a friendly voice assistant on a phone-style call for a small clinic. " +
    "Reply in short, natural spoken sentences — no markdown, no lists, no emoji. " +
    "Be concise: one or two sentences unless the caller asks for more. " +
    `Today is ${weekday}, ${today}. ` +
    "You can book appointments. When the caller wants one: call check_availability " +
    "for the requested date first. If they named only a general time of day (morning, " +
    "afternoon), pick the matching open slot yourself and book it immediately — do not " +
    "ask them to choose. Always call book_appointment to actually book; never claim a " +
    "booking without it. After booking, read back the time and the confirmation code."
  );
}

const MAX_HISTORY_TURNS = 20; // user+model messages kept for context
const MAX_TOOL_ROUNDS = 4;

export class LlmClient {
  private ai: GoogleGenAI;
  private history: Content[] = [];

  constructor(
    apiKey: string,
    private tools: ToolSet | null = null,
    private model: string = "gemini-3.1-flash-lite"
  ) {
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
   * Stream a reply to userText, executing tool calls between rounds.
   * Aborts cleanly when `signal` fires: the loop stops consuming and the
   * aborted exchange is not committed to history.
   */
  async respond(userText: string, events: LlmEvents, signal?: AbortSignal): Promise<void> {
    const sentAt = Date.now();
    let firstToken = true;
    let fullText = "";
    const contents: Content[] = [...this.history, { role: "user", parts: [{ text: userText }] }];

    const config: Record<string, unknown> = {
      systemInstruction: systemInstruction(),
      abortSignal: signal,
    };
    if (this.tools) {
      config.tools = [{ functionDeclarations: this.tools.declarations }];
    }

    try {
      for (let round = 0; round < MAX_TOOL_ROUNDS + 1; round++) {
        const stream = await this.ai.models.generateContentStream({
          model: this.model,
          contents,
          config,
        });

        const calls: { name: string; args: Record<string, unknown>; id?: string }[] = [];
        // Keep the model's parts verbatim (incl. thoughtSignature) — Gemini 3.x
        // rejects replayed functionCall parts that lost their thought signature.
        const modelParts: Part[] = [];
        for await (const chunk of stream) {
          if (signal?.aborted) return;
          const parts = chunk.candidates?.[0]?.content?.parts ?? [];
          for (const part of parts) {
            modelParts.push(part);
            if (part.text) {
              if (firstToken) {
                firstToken = false;
                events.onFirstToken(Date.now() - sentAt);
              }
              fullText += part.text;
              events.onDelta(part.text);
            }
            if (part.functionCall?.name) {
              calls.push({
                name: part.functionCall.name,
                args: (part.functionCall.args as Record<string, unknown>) ?? {},
                id: part.functionCall.id,
              });
            }
          }
        }
        if (signal?.aborted) return;

        if (calls.length === 0) break; // final answer reached

        if (round === MAX_TOOL_ROUNDS) {
          events.onError({
            source: "llm",
            code: "TOOL_LOOP_LIMIT",
            message: `model still calling tools after ${MAX_TOOL_ROUNDS} rounds`,
          });
          return;
        }

        // Execute tools; feed results back and go another round.
        const responseParts: Part[] = [];
        for (const call of calls) {
          events.onToolCall?.(call.name, call.args);
          const result = this.tools
            ? this.tools.execute(call.name, call.args)
            : { error: "no tools available" };
          events.onToolResult?.(call.name, result);
          responseParts.push({
            functionResponse: { name: call.name, response: result, id: call.id },
          });
        }
        contents.push({ role: "model", parts: modelParts }); // verbatim, signatures intact
        contents.push({ role: "user", parts: responseParts });
      }

      if (signal?.aborted) return;
      // Commit compact history: the user turn and the final spoken reply (which
      // contains anything worth remembering, e.g. the confirmation code).
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
