// llm.ts — transcript + history in, streamed text tokens + tool calls out.
// Implementation: Google Gemini via the official @google/genai SDK.
// Model: gemini-3.1-flash-lite — measured ~600 ms first token on the free tier;
// gemini-3.5-flash measured 6-18 s (thinking pipeline) and the 2.5 models are
// retired for new API keys. History is kept client-side (this model is not
// served by the Interactions API).
// Provider-swappable: keep everything Gemini-specific behind LlmClient.

import { GoogleGenAI, Content, Part } from "@google/genai";
import { ToolSet } from "./tools";
import { AgentConfig, buildSystemInstruction } from "./config";
import { Llm, LlmEvents, LlmError } from "./llm-types";

// Re-export the provider-neutral types so existing importers keep working.
export type { Llm, LlmEvents, LlmError } from "./llm-types";

const MAX_HISTORY_TURNS = 20; // user+model messages kept for context
const MAX_TOOL_ROUNDS = 4;
const RESPONSE_TIMEOUT_MS = 15_000; // whole reply incl. tool rounds
const MAX_ATTEMPTS = 2; // 1 retry, and only if nothing was emitted yet

export class LlmClient implements Llm {
  private ai: GoogleGenAI;
  private history: Content[] = [];

  constructor(
    apiKey: string,
    private tools: ToolSet | null = null,
    private config: AgentConfig,
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

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const err = await this.attempt(
        userText,
        events,
        sentAt,
        () => firstToken,
        (v) => (firstToken = v),
        signal
      );
      if (err === null) return; // success, abort, or already-reported error
      // Retry only if nothing was spoken yet and we have attempts left.
      if (!firstToken || attempt === MAX_ATTEMPTS) {
        events.onError(err);
        return;
      }
      console.log(`[llm] attempt ${attempt} failed (${err.code}: ${err.message}) — retrying once`);
    }
  }

  /** One attempt. Returns null on success/abort/self-reported error; an LlmError if retryable. */
  private async attempt(
    userText: string,
    events: LlmEvents,
    sentAt: number,
    isFirstToken: () => boolean,
    setFirstToken: (v: boolean) => void,
    signal?: AbortSignal
  ): Promise<LlmError | null> {
    let fullText = "";
    const contents: Content[] = [...this.history, { role: "user", parts: [{ text: userText }] }];

    // Hard wall-clock cap on the whole reply: abort the SDK via our own
    // controller so a hung provider can't wedge the session.
    const ac = new AbortController();
    let timedOut = false;
    const onCallerAbort = () => ac.abort();
    signal?.addEventListener("abort", onCallerAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      ac.abort();
    }, RESPONSE_TIMEOUT_MS);

    const config: Record<string, unknown> = {
      systemInstruction: buildSystemInstruction(this.config, new Date()),
      abortSignal: ac.signal,
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
          if (signal?.aborted) return null;
          const parts = chunk.candidates?.[0]?.content?.parts ?? [];
          for (const part of parts) {
            modelParts.push(part);
            if (part.text) {
              if (isFirstToken()) {
                setFirstToken(false);
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
        if (signal?.aborted) return null;

        if (calls.length === 0) break; // final answer reached

        if (round === MAX_TOOL_ROUNDS) {
          return {
            source: "llm",
            code: "TOOL_LOOP_LIMIT",
            message: `model still calling tools after ${MAX_TOOL_ROUNDS} rounds`,
          };
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

      if (signal?.aborted) return null;
      // Commit compact history: the user turn and the final spoken reply (which
      // contains anything worth remembering, e.g. the confirmation code).
      this.history.push({ role: "user", parts: [{ text: userText }] });
      this.history.push({ role: "model", parts: [{ text: fullText }] });
      if (this.history.length > MAX_HISTORY_TURNS) {
        this.history = this.history.slice(-MAX_HISTORY_TURNS);
      }
      events.onDone(fullText);
      return null;
    } catch (err) {
      if (signal?.aborted) return null; // caller aborted mid-request; not an error
      if (timedOut) {
        return {
          source: "llm",
          code: "TIMEOUT",
          message: `no completion within ${RESPONSE_TIMEOUT_MS}ms`,
        };
      }
      const message = err instanceof Error ? err.message : String(err);
      return { source: "llm", code: "REQUEST_FAILED", message };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onCallerAbort);
    }
  }
}
