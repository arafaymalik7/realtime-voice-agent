# CLAUDE.md — Real-Time Voice AI Agent

This file is the source of truth for this project. Read it fully before doing anything. Follow the WORKFLOW rules exactly. Do not skip phases. Do not mark a phase done without passing its CHECK.

---

## 1. What we are building

A browser-based real-time voice agent. A person speaks into their mic; the agent listens, thinks, and speaks back in a natural conversation with sub-second responsiveness. It can be interrupted mid-sentence (barge-in), can call tools during the conversation (e.g. book an appointment, look something up), and fails loudly and safely instead of guessing.

The hard, valuable part of this project is the TURN-TAKING LOOP: streaming audio in, detecting when the human stops, responding fast enough that it feels alive, and stopping instantly when the human talks over the agent. Everything else is plumbing around that core. Optimize for that.

## 2. Non-negotiable priorities (in order)

1. **Latency.** Target: from the moment the human stops speaking to the moment the agent's first audio byte plays, under 1500 ms. Measure it, log it, print the number. If a design choice adds latency, flag it.
2. **Barge-in.** When the human speaks while the agent is talking, the agent's audio stops within 300 ms and it starts listening.
3. **Safe failure.** Any component failure produces a loud, structured error and a spoken fallback ("Sorry, I'm having trouble — let me get a human"), never a silent hang or a confident hallucination.
4. **Security.** See section 7. This is not optional and not a final-phase afterthought.

## 3. Tech stack (defaults — confirm current details before coding)

- **Language:** TypeScript (Node.js backend, vanilla TS or minimal React frontend — keep the frontend thin, this is not a UI project).
- **Transport:** WebSocket (raw `ws` on the server). Audio streams as binary frames.
- **STT (speech-to-text):** Deepgram streaming API. Use its interim results + endpointing/utterance-end events for turn detection.
- **LLM:** Anthropic Claude via the official SDK, streaming, with tool use.
- **TTS (text-to-speech):** ElevenLabs streaming API. If Phase 5 latency budget is blown, evaluate Cartesia Sonic as a lower-latency swap — keep TTS behind a single interface so it can be replaced in one file.
- **Audio in browser:** capture mic with the Web Audio API (`AudioWorklet` preferred over the deprecated `ScriptProcessorNode`), downsample to the format the STT expects (commonly 16 kHz linear PCM — verify), stream out. Play returned audio through the Web Audio API so it can be stopped instantly for barge-in.

> IMPORTANT: model names, endpoints, audio formats, and SDK signatures for Deepgram, Anthropic, and ElevenLabs change over time. Before writing integration code for each, fetch and read the CURRENT official docs for that provider. Do NOT rely on memory for exact model IDs, WebSocket URLs, or parameter names. If you cannot verify a detail, stop and tell me rather than guessing.

## 4. Architecture

```
Browser                         Node server (orchestrator)              External APIs
┌───────────────┐   binary     ┌──────────────────────────┐
│ mic capture   │──audio──────▶│ WS handler                │
│ (AudioWorklet)│              │  ├─ session state machine │──▶ Deepgram (STT stream)
│               │              │  ├─ turn detector         │◀── transcripts + endpoint
│ audio player  │◀─binary─────│  ├─ LLM caller (stream)   │──▶ Claude (stream + tools)
│ (barge-in     │   audio      │  ├─ tool executor        │
│  stop control)│              │  └─ TTS streamer          │──▶ ElevenLabs (TTS stream)
└───────────────┘              └──────────────────────────┘
```

Keep each concern in its own module with a defined input and output:
- `stt.ts` — audio frames in, transcript + "user finished speaking" events out.
- `turn.ts` — decides whose turn it is (a small explicit state machine: LISTENING → THINKING → SPEAKING → interruptible).
- `llm.ts` — transcript + history in, streamed text tokens + tool calls out.
- `tools.ts` — one function per tool, defined inputs/outputs, no side effects beyond the tool's one job.
- `tts.ts` — text in, audio frames out; single swappable interface.
- `session.ts` — owns per-connection state, wires the modules, enforces the state machine.

## 5. WORKFLOW — how you must work (read carefully)

You work in phases (section 6). For EACH phase:

1. **PLAN first.** Before writing code, write a short plan for this phase only: files you'll create/change, the approach, the exact CHECK you'll run, and any doc you need to verify. Show me the plan and WAIT for my "go" before implementing. Do not plan more than one phase ahead.
2. **Implement** the phase.
3. **Run the CHECK.** Report the actual measured result (the number/diff), not "looks good."
4. If the CHECK passes → summarize, then propose the next phase's plan.
5. If the CHECK fails → do NOT patch blindly. Re-plan: state what you expected, what happened, your hypothesis, and the fix. Retry cap: **3 attempts** on the same failure. After 3, STOP and hand it to me with everything you've learned. Never loop silently.
6. Commit at the end of each passing phase with a clear message. Keep commits phase-sized.

Keep me in the loop but do not waste turns: one concise plan, implement, one concise result. No filler.

## 6. Phased plan (each phase ends with a hard CHECK)

**Phase 0 — Skeleton.** Node + TS project, `ws` server, a static page served, WebSocket connects, `.env` loading, `.env.example`, `.gitignore`, health endpoint.
CHECK: page loads, WS connects, server logs "connected"; `npm run build` and `npm audit` both clean.

**Phase 1 — Audio uplink.** Browser captures mic via AudioWorklet, streams binary PCM to the server. Server logs frames.
CHECK: while speaking for 5 s, server logs ≥ 40 audio frames, each within the expected byte-size range. Print counts.

**Phase 2 — STT + endpointing.** Pipe audio to Deepgram; return live transcripts to the browser; detect utterance-end.
CHECK: say the fixed sentence "the quick brown fox jumps over the lazy dog" — transcript word-accuracy ≥ 90%; utterance-end event fires within 800 ms of you going silent. Print the measured gap.

**Phase 3 — LLM reasoning.** On utterance-end, send transcript + short history to Claude (streaming). Display the streamed text reply. No audio yet.
CHECK: ask "what's two plus two, answer in one word" — reply is "Four"; first text token arrives < 700 ms after send. Print the latency.

**Phase 4 — First full voice loop.** Stream Claude's text into ElevenLabs, stream audio back, play it. It talks now.
CHECK: full round trip works; measure and print end-of-user-speech → first-agent-audio-byte latency. Target < 1500 ms. Record the number; it's the headline metric.

**Phase 5 — THE HARD PART: barge-in + tuning.** Implement the turn state machine. While the agent speaks, if the user speaks, stop agent audio immediately (both server-side TTS stream and browser playback) and switch to LISTENING. Tune endpointing so it doesn't cut the user off mid-thought or lag.
CHECK: interrupt the agent mid-sentence 5 times; audio stops within 300 ms every time (print each measured stop-latency); zero cases where the old reply resumes after interruption.

**Phase 6 — Tools mid-conversation.** Add 2 tools with defined I/O (e.g. `check_availability(date)` returning fixed slots, `book_appointment(slot, name)` returning a confirmation id). Claude calls them during the call; results are spoken.
CHECK: say "book me in for tomorrow afternoon" — the correct tool fires with correct args, a confirmation id comes back, and the agent speaks it. Print the tool call + args + result.

**Phase 7 — Safe failure.** Wrap every external call with timeouts, a retry cap, and a structured error. On failure the agent speaks a fallback line and the session ends cleanly. Simulate each provider being down.
CHECK: kill each provider (bad key / block network) one at a time — in all 3 cases the user hears the fallback line, the error is logged structured, nothing hangs. Confirm all 3.

**Phase 8 — Security + latency hardening.** Full pass against section 7. Re-measure headline latency under load.
CHECK: section 7 checklist all pass; `npm audit` clean; no secret reachable from the browser bundle (grep the built client for key patterns → zero hits). Print the final latency number.

## 7. Security requirements (verify every item in Phase 8, but honor throughout)

- **API keys live server-side only.** Never sent to the browser, never in client code, never in logs. Loaded from `.env`. Provide `.env.example` with placeholder values only.
- `.env` and any secret file are in `.gitignore`. Verify nothing secret is committed (`git log -p` scan for keys before final commit).
- **WebSocket hardening:** check the `Origin` header against an allowlist; require a short-lived session token to open a session; cap inbound message size; idle-timeout dead connections; limit concurrent connections per IP.
- **Validate all inbound messages.** Never trust client-sent JSON; reject unknown types.
- **No PII in logs by default.** Transcripts contain user speech — redact or gate behind an explicit debug flag. Never log audio.
- **Least privilege on tools.** Tools do exactly one job; no tool can run arbitrary commands, shell out, or hit unlisted URLs.
- **Rate-limit** LLM/STT/TTS calls per session to cap cost-abuse.
- Run `npm audit` each phase; no high/critical unresolved at the end.
- Do not add a dependency without noting why. Prefer fewer, well-known packages.

## 8. Definition of done

A person opens the page, clicks "start", has a natural spoken conversation, can interrupt the agent, can get it to book a fake appointment by voice, and if any backend piece fails they hear a graceful fallback instead of silence. Headline latency (end-of-speech → first-audio) is measured and printed, under 1500 ms. Security checklist passes. Code is in phase-sized commits.

## 9. Things NOT to do

- Do not put secrets in the client.
- Do not fake the hard part with pre-recorded audio or a fixed script.
- Do not skip a CHECK or replace a measurement with "it works."
- Do not silently retry forever — 3 strikes then hand it to me.
- Do not guess a provider's current model name or API shape — verify from live docs.
- Do not over-build the UI. One page, two buttons, a transcript, and latency readouts.
