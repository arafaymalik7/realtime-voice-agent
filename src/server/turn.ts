// turn.ts — decides whose turn it is. Explicit state machine:
//   LISTENING -> THINKING (eager reply in flight, audio buffered)
//   THINKING  -> SPEAKING (turn confirmed, audio streaming to client)
//   any       -> LISTENING (barge-in, void, or reply finished)
// Owns the full reply lifecycle: eager start, confirm, void, barge-in stop.

import { LlmClient, LlmError } from "./llm";
import { TtsStream, TtsEvents } from "./tts";

export type TurnState = "LISTENING" | "THINKING" | "SPEAKING";

export interface TurnDeps {
  llm: LlmClient | null;
  /** Returns a fresh TTS stream for one reply, or null if TTS is unavailable. */
  createTts: (events: TtsEvents) => TtsStream | null;
  sendJson: (obj: unknown) => void;
  sendAudio: (pcm: Buffer) => void;
  log: (msg: string) => void;
}

export class TurnManager {
  private state: TurnState = "LISTENING";

  // In-flight reply
  private llmAbort: AbortController | null = null;
  private tts: TtsStream | null = null;
  private replyTranscript: string | null = null;
  private replyLive = false;
  private replyBuffer: Buffer[] = [];
  private firstByteSent = false;
  private speechEndWallMs: number | null = null;
  private ttsFinished = true;

  constructor(private deps: TurnDeps) {}

  getState(): TurnState {
    return this.state;
  }

  private setState(next: TurnState, why: string): void {
    if (this.state === next) return;
    this.deps.log(`turn: ${this.state} -> ${next} (${why})`);
    this.state = next;
    this.deps.sendJson({ type: "turn_state", state: next });
  }

  // ---- STT events ----

  onEagerEndOfTurn(transcript: string, speechEndWallMs: number | null): void {
    if (transcript.trim().length === 0) return;
    if (this.replyTranscript === transcript) return; // already answering exactly this
    this.startReply(transcript, speechEndWallMs, /* live */ false);
  }

  onEndOfTurn(transcript: string, speechEndWallMs: number | null): void {
    if (transcript.trim().length === 0) return;
    if (this.replyTranscript === transcript && !this.replyLive) {
      this.deps.log("turn: eager reply confirmed, flushing buffered audio");
      this.goLive();
    } else if (this.replyTranscript !== transcript) {
      this.startReply(transcript, speechEndWallMs, /* live */ true);
    }
  }

  onTurnResumed(): void {
    if (this.replyTranscript !== null && !this.replyLive) {
      this.deps.log("turn: user kept talking — voiding eager reply");
      this.stopReply("turn resumed");
    }
  }

  /** User audibly started a new turn. If the agent is speaking, that's a barge-in. */
  onStartOfTurn(): void {
    if (this.state === "SPEAKING") {
      this.deps.log("turn: barge-in detected via STT StartOfTurn");
      this.bargeIn("stt fallback");
    }
  }

  // ---- Client events ----

  /** Client-side VAD detected the user talking over agent audio. */
  onClientBargeIn(): void {
    this.bargeIn("client vad");
  }

  onDisconnect(): void {
    this.stopReply("disconnect");
  }

  // ---- Reply lifecycle ----

  private bargeIn(source: string): void {
    if (this.replyTranscript === null && this.ttsFinished) {
      // Nothing in flight server-side; client may still be draining old scheduled
      // audio — tell it to stop regardless.
      this.deps.sendJson({ type: "stop_audio" });
      this.setState("LISTENING", `barge-in (${source}), nothing in flight`);
      return;
    }
    this.deps.log(`turn: BARGE-IN (${source}) — stopping agent audio`);
    this.stopReply(`barge-in (${source})`);
    this.deps.sendJson({ type: "stop_audio" });
  }

  private stopReply(why: string): void {
    this.llmAbort?.abort();
    this.llmAbort = null;
    this.tts?.abort();
    this.tts = null;
    this.replyTranscript = null;
    this.replyLive = false;
    this.replyBuffer = [];
    this.firstByteSent = false;
    this.ttsFinished = true;
    this.setState("LISTENING", why);
  }

  private goLive(): void {
    this.replyLive = true;
    for (const pcm of this.replyBuffer) this.deliverAudio(pcm);
    this.replyBuffer = [];
  }

  private deliverAudio(pcm: Buffer): void {
    if (!this.firstByteSent) {
      this.firstByteSent = true;
      const headline = this.speechEndWallMs !== null ? Date.now() - this.speechEndWallMs : null;
      this.deps.log(`tts: first audio byte to client (headline speech-end -> first-byte ${headline}ms)`);
      this.deps.sendJson({ type: "metric", name: "headline_server_ms", value: headline });
      this.setState("SPEAKING", "first audio byte delivered");
    }
    this.deps.sendAudio(pcm);
  }

  private startReply(transcript: string, speechEndWallMs: number | null, live: boolean): void {
    const { llm, createTts, sendJson, log } = this.deps;
    if (!llm) {
      const err = { source: "llm", code: "NO_API_KEY", message: "GEMINI_API_KEY not set" };
      log(`ERROR ${JSON.stringify(err)}`);
      sendJson({ type: "error", ...err });
      return;
    }

    this.stopReply("superseded by new turn");
    const abort = new AbortController();
    this.llmAbort = abort;
    this.replyTranscript = transcript;
    this.replyLive = live;
    this.speechEndWallMs = speechEndWallMs;
    this.ttsFinished = false;
    this.setState("THINKING", live ? "final turn, replying" : "eager turn, replying tentatively");

    // Open TTS now — its handshake overlaps LLM inference.
    const replyTts = createTts({
      onAudio: (pcm) => {
        if (this.tts !== replyTts) return; // stale stream after a stop
        if (this.replyLive) this.deliverAudio(pcm);
        else this.replyBuffer.push(pcm);
      },
      onDone: () => {
        if (this.tts !== replyTts) return;
        this.ttsFinished = true;
        sendJson({ type: "tts_done" });
        // Reply fully generated & delivered. Client keeps playing its scheduled
        // buffer; server-side the turn is complete.
        this.replyTranscript = null;
        this.setState("LISTENING", "reply fully delivered");
      },
      onError: (e) => {
        if (this.tts !== replyTts) return;
        log(`ERROR ${JSON.stringify(e)}`);
        sendJson({ type: "error", ...e });
        this.stopReply("tts error");
      },
    });
    this.tts = replyTts;

    sendJson({ type: "speech_end", wallMs: speechEndWallMs });
    log(`llm: request sent for "${transcript}"`);

    void llm.respond(
      transcript,
      {
        onFirstToken: (latencyMs) => {
          log(`llm: first token in ${latencyMs}ms`);
          sendJson({ type: "metric", name: "llm_first_token_ms", value: latencyMs });
        },
        onDelta: (text) => {
          if (abort.signal.aborted) return;
          sendJson({ type: "agent", delta: text });
          replyTts?.sendText(text);
        },
        onToolCall: (name, args) => {
          if (abort.signal.aborted) return;
          log(`tool: CALL ${name}(${JSON.stringify(args)})`);
          sendJson({ type: "tool_call", name, args });
        },
        onToolResult: (name, result) => {
          if (abort.signal.aborted) return;
          log(`tool: RESULT ${name} -> ${JSON.stringify(result)}`);
          sendJson({ type: "tool_result", name, result });
        },
        onDone: (fullText) => {
          if (abort.signal.aborted) return;
          log(`llm: done reply="${fullText}"`);
          sendJson({ type: "agent_done" });
          replyTts?.end();
        },
        onError: (e: LlmError) => {
          if (abort.signal.aborted) return;
          log(`ERROR ${JSON.stringify(e)}`);
          sendJson({ type: "error", ...e });
          replyTts?.abort();
        },
      },
      abort.signal
    );
  }
}
