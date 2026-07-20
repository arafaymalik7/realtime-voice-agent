// llm-types.ts — provider-neutral LLM contract. Any provider (Gemini today,
// Groq/Anthropic/etc. later) implements `Llm`; the rest of the server depends
// only on this interface, so swapping providers is a one-file change.

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

export interface Llm {
  /** Pre-establish the connection so the first real request is fast. */
  warmup(): void;
  /**
   * Stream a reply to `userText`, executing tool calls between rounds.
   * Must abort cleanly when `signal` fires without emitting further events.
   */
  respond(userText: string, events: LlmEvents, signal?: AbortSignal): Promise<void>;
}
