// llm-groq.ts — Groq implementation of the Llm interface.
// Groq serves open models on an OpenAI-compatible API with very low first-token
// latency (typically ~150-300 ms), which addresses the free-tier Gemini jitter
// documented in the README. No SDK dependency: streams over fetch + SSE.
//
// STATUS: written against Groq's documented API but NOT yet verified against a
// live key (this repo defaults to Gemini). Set LLM_PROVIDER=groq + GROQ_API_KEY
// to enable, then confirm the booking flow before relying on it.

import { ToolSet } from "./tools";
import { AgentConfig, buildSystemInstruction } from "./config";
import { Llm, LlmEvents, LlmError } from "./llm-types";

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const MAX_HISTORY_MESSAGES = 20;
const MAX_TOOL_ROUNDS = 4;
const RESPONSE_TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 2;

// OpenAI-compatible message shapes.
interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}
interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export class GroqLlmClient implements Llm {
  private history: ChatMessage[] = [];

  constructor(
    private apiKey: string,
    private tools: ToolSet | null,
    private config: AgentConfig,
    private model: string = "llama-3.3-70b-versatile"
  ) {}

  warmup(): void {
    // Cheap request to warm the TLS connection; ignore the result.
    void fetch("https://api.groq.com/openai/v1/models", {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    }).catch(() => {});
  }

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
      if (err === null) return;
      if (!firstToken || attempt === MAX_ATTEMPTS) {
        events.onError(err);
        return;
      }
      console.log(`[groq] attempt ${attempt} failed (${err.code}) — retrying once`);
    }
  }

  private toolDefs(): unknown[] | undefined {
    if (!this.tools) return undefined;
    return this.tools.declarations.map((d) => ({
      type: "function",
      function: {
        name: d.name,
        description: d.description,
        parameters: d.parametersJsonSchema,
      },
    }));
  }

  private async attempt(
    userText: string,
    events: LlmEvents,
    sentAt: number,
    isFirstToken: () => boolean,
    setFirstToken: (v: boolean) => void,
    signal?: AbortSignal
  ): Promise<LlmError | null> {
    let fullText = "";
    const messages: ChatMessage[] = [
      { role: "system", content: buildSystemInstruction(this.config, new Date()) },
      ...this.history,
      { role: "user", content: userText },
    ];
    const tools = this.toolDefs();

    const ac = new AbortController();
    let timedOut = false;
    const onAbort = () => ac.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      ac.abort();
    }, RESPONSE_TIMEOUT_MS);

    try {
      for (let round = 0; round < MAX_TOOL_ROUNDS + 1; round++) {
        const res = await fetch(GROQ_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: this.model,
            messages,
            stream: true,
            ...(tools ? { tools, tool_choice: "auto" } : {}),
          }),
          signal: ac.signal,
        });

        if (!res.ok || !res.body) {
          const body = await res.text().catch(() => "");
          return { source: "llm", code: `HTTP_${res.status}`, message: body.slice(0, 300) };
        }

        // Accumulate this round's assistant message: text + tool calls (by index).
        const toolCalls = new Map<number, ToolCall>();
        for await (const delta of streamDeltas(res.body, ac.signal)) {
          if (signal?.aborted) return null;
          const content = delta.content;
          if (content) {
            if (isFirstToken()) {
              setFirstToken(false);
              events.onFirstToken(Date.now() - sentAt);
            }
            fullText += content;
            events.onDelta(content);
          }
          for (const tc of delta.tool_calls ?? []) {
            const cur = toolCalls.get(tc.index) ?? {
              id: "",
              type: "function" as const,
              function: { name: "", arguments: "" },
            };
            if (tc.id) cur.id = tc.id;
            if (tc.function?.name) cur.function.name = tc.function.name;
            if (tc.function?.arguments) cur.function.arguments += tc.function.arguments;
            toolCalls.set(tc.index, cur);
          }
        }
        if (signal?.aborted) return null;

        const calls = [...toolCalls.values()];
        if (calls.length === 0) break; // final answer

        if (round === MAX_TOOL_ROUNDS) {
          return {
            source: "llm",
            code: "TOOL_LOOP_LIMIT",
            message: `still calling tools after ${MAX_TOOL_ROUNDS} rounds`,
          };
        }

        // Echo the assistant tool-call message, then one tool result per call.
        messages.push({ role: "assistant", content: null, tool_calls: calls });
        for (const call of calls) {
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(call.function.arguments || "{}");
          } catch {
            /* malformed args -> tool will report the error */
          }
          events.onToolCall?.(call.function.name, args);
          const result = this.tools
            ? this.tools.execute(call.function.name, args)
            : { error: "no tools available" };
          events.onToolResult?.(call.function.name, result);
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: JSON.stringify(result),
          });
        }
      }

      if (signal?.aborted) return null;
      this.history.push({ role: "user", content: userText });
      this.history.push({ role: "assistant", content: fullText });
      if (this.history.length > MAX_HISTORY_MESSAGES) {
        this.history = this.history.slice(-MAX_HISTORY_MESSAGES);
      }
      events.onDone(fullText);
      return null;
    } catch (err) {
      if (signal?.aborted) return null;
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
      signal?.removeEventListener("abort", onAbort);
    }
  }
}

export interface StreamDelta {
  content?: string;
  tool_calls?: Array<{
    index: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }>;
}

/** Parse an OpenAI-style SSE body into per-chunk deltas. Exported for testing. */
export async function* streamDeltas(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal
): AsyncGenerator<StreamDelta> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? ""; // keep the trailing partial line
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") return;
        try {
          const json = JSON.parse(data);
          const delta = json.choices?.[0]?.delta as StreamDelta | undefined;
          if (delta) yield delta;
        } catch {
          /* ignore keep-alives / non-JSON lines */
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
