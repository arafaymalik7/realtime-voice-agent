import { test } from "node:test";
import assert from "node:assert/strict";
import { TurnManager, TurnDeps } from "../src/server/turn";
import type { LlmClient, LlmEvents } from "../src/server/llm";
import type { TtsStream, TtsEvents } from "../src/server/tts";

// A controllable fake TTS: records calls, lets the test push audio / finish.
class FakeTts {
  aborted = false;
  ended = false;
  sentText: string[] = [];
  constructor(public events: TtsEvents) {}
  sendText(t: string) {
    this.sentText.push(t);
  }
  end() {
    this.ended = true;
  }
  abort() {
    this.aborted = true;
  }
}

interface Harness {
  turn: TurnManager;
  sent: Array<Record<string, unknown>>;
  audio: Buffer[];
  ttsInstances: FakeTts[];
  llmEvents: () => LlmEvents | null;
  setAllow: (v: boolean) => void;
  types: () => string[];
  states: () => string[];
}

function makeHarness(): Harness {
  const sent: Array<Record<string, unknown>> = [];
  const audio: Buffer[] = [];
  const ttsInstances: FakeTts[] = [];
  let allow = true;
  let capturedLlmEvents: LlmEvents | null = null;

  const deps: TurnDeps = {
    llm: {
      respond: async (_text: string, events: LlmEvents) => {
        capturedLlmEvents = events; // assigned synchronously before any await
      },
    } as unknown as LlmClient,
    createTts: (events: TtsEvents) => {
      const t = new FakeTts(events);
      ttsInstances.push(t);
      return t as unknown as TtsStream;
    },
    sendJson: (o) => sent.push(o as Record<string, unknown>),
    sendAudio: (b) => audio.push(b),
    log: () => {},
    onFatal: (e) => sent.push({ type: "fatal", ...e }),
    allowReply: () => allow,
    redact: (t) => t,
  };

  return {
    turn: new TurnManager(deps),
    sent,
    audio,
    ttsInstances,
    llmEvents: () => capturedLlmEvents,
    setAllow: (v) => (allow = v),
    types: () => sent.map((m) => String(m.type)),
    states: () => sent.filter((m) => m.type === "turn_state").map((m) => String(m.state)),
  };
}

const PCM = Buffer.from([1, 2, 3, 4]);

test("eager end-of-turn moves to THINKING and buffers audio (no delivery yet)", () => {
  const h = makeHarness();
  h.turn.onEagerEndOfTurn("hello there", 1000);
  assert.equal(h.turn.getState(), "THINKING");
  // TTS produces audio before the turn is confirmed — must be buffered, not sent.
  h.ttsInstances[0].events.onAudio(PCM);
  assert.equal(h.audio.length, 0, "audio must not be delivered before confirmation");
});

test("confirming EndOfTurn flushes buffered audio and moves to SPEAKING", () => {
  const h = makeHarness();
  h.turn.onEagerEndOfTurn("hello there", 1000);
  h.ttsInstances[0].events.onAudio(PCM); // buffered
  h.turn.onEndOfTurn("hello there", 1000); // same transcript -> go live
  assert.equal(h.turn.getState(), "SPEAKING");
  assert.equal(h.audio.length, 1, "buffered audio should flush on confirmation");
  assert.ok(
    h.types().includes("headline_server_ms") || h.sent.some((m) => m.name === "headline_server_ms")
  );
});

test("TurnResumed voids an unconfirmed eager reply and aborts its TTS", () => {
  const h = makeHarness();
  h.turn.onEagerEndOfTurn("hel", 1000);
  const tts = h.ttsInstances[0];
  h.turn.onTurnResumed();
  assert.equal(h.turn.getState(), "LISTENING");
  assert.equal(tts.aborted, true);
});

test("client barge-in stops the reply, sends stop_audio, returns to LISTENING", () => {
  const h = makeHarness();
  h.turn.onEagerEndOfTurn("hello", 1000);
  h.ttsInstances[0].events.onAudio(PCM);
  h.turn.onEndOfTurn("hello", 1000); // SPEAKING
  const tts = h.ttsInstances[0];
  h.turn.onClientBargeIn();
  assert.equal(h.turn.getState(), "LISTENING");
  assert.equal(tts.aborted, true);
  assert.ok(h.types().includes("stop_audio"));
});

test("rate-limited reply sends a soft notice and does not enter THINKING", () => {
  const h = makeHarness();
  h.setAllow(false);
  h.turn.onEndOfTurn("hello", 1000);
  assert.equal(h.turn.getState(), "LISTENING");
  assert.equal(h.ttsInstances.length, 0, "no TTS should be opened when rate-limited");
  const notice = h.sent.find((m) => m.type === "notice");
  assert.ok(notice, "expected a soft notice");
  assert.equal(notice!.code, "RATE_LIMITED");
});

test("empty / whitespace transcript is ignored", () => {
  const h = makeHarness();
  h.turn.onEagerEndOfTurn("   ", 1000);
  h.turn.onEndOfTurn("", 1000);
  assert.equal(h.turn.getState(), "LISTENING");
  assert.equal(h.ttsInstances.length, 0);
});

test("a new final turn supersedes an in-flight reply and aborts the old TTS", () => {
  const h = makeHarness();
  h.turn.onEndOfTurn("first question", 1000); // THINKING, tts[0]
  h.turn.onEndOfTurn("second question", 2000); // supersede -> tts[0] aborted, tts[1] new
  assert.equal(h.ttsInstances.length, 2);
  assert.equal(h.ttsInstances[0].aborted, true);
  assert.equal(h.turn.getState(), "THINKING");
});

test("LLM deltas are forwarded to the TTS as text", () => {
  const h = makeHarness();
  h.turn.onEndOfTurn("hello", 1000);
  const ev = h.llmEvents();
  assert.ok(ev, "llm.respond should have been called with events");
  ev!.onDelta("Hi ");
  ev!.onDelta("there.");
  assert.deepEqual(h.ttsInstances[0].sentText, ["Hi ", "there."]);
});

test("LLM done ends the TTS stream", () => {
  const h = makeHarness();
  h.turn.onEndOfTurn("hello", 1000);
  h.llmEvents()!.onDone("Hi there.");
  assert.equal(h.ttsInstances[0].ended, true);
  assert.ok(h.types().includes("agent_done"));
});

test("a TTS error triggers the fatal path", () => {
  const h = makeHarness();
  h.turn.onEndOfTurn("hello", 1000);
  h.ttsInstances[0].events.onError({ source: "tts", code: "BOOM", message: "kaboom" });
  assert.ok(h.sent.some((m) => m.type === "fatal" && m.code === "BOOM"));
});
