# Realtime Voice Agent

A browser-based real-time voice AI agent: speak into your mic, the agent listens, thinks, and talks back — interruptible mid-sentence, with sub-second turn detection.

The core of this project is the **turn-taking loop**: streaming audio in, detecting when the human stops speaking, responding fast enough to feel alive, and stopping instantly when the human talks over the agent (barge-in).

## Architecture

```
Browser                         Node server (orchestrator)              External APIs
┌───────────────┐   binary     ┌──────────────────────────┐
│ mic capture   │──audio──────▶│ WS handler                │
│ (AudioWorklet)│              │  ├─ session state machine │──▶ Deepgram Flux (STT stream)
│  + energy VAD │              │  ├─ turn detector         │◀── transcripts + turn events
│ audio player  │◀─binary─────│  ├─ LLM caller (stream)   │──▶ Gemini (stream)
│ (instant-stop │   audio      │  └─ TTS streamer          │──▶ ElevenLabs (TTS stream)
│  barge-in)    │              └──────────────────────────┘
└───────────────┘
```

| Module | Responsibility |
|---|---|
| [`src/server/stt.ts`](src/server/stt.ts) | Audio frames in → transcript + turn events out (Deepgram Flux, `v2/listen`) |
| [`src/server/turn.ts`](src/server/turn.ts) | Turn state machine: `LISTENING → THINKING → SPEAKING`, eager replies, barge-in |
| [`src/server/llm.ts`](src/server/llm.ts) | Transcript + history in → streamed tokens out (Gemini, abortable mid-stream) |
| [`src/server/tts.ts`](src/server/tts.ts) | Text in → 16 kHz PCM out (ElevenLabs Flash over WebSocket, swappable interface) |
| [`src/server/index.ts`](src/server/index.ts) | HTTP/WS server, wiring, validation |
| [`public/worklet/capture.js`](public/worklet/capture.js) | Mic capture, 48→16 kHz resampling, voice-activity detection |

## Latency engineering

Measured on a free-tier stack (all numbers from real runs, logged by the built-in instrumentation):

| Metric | Measured | Notes |
|---|---|---|
| Barge-in: user speaks → agent audio stops | **64 ms** (8/8 runs) | Client-side energy VAD; no network round trip |
| End-of-turn detection (human voice) | ~480–650 ms | Deepgram Flux model-integrated turn detection |
| LLM first token | ~550 ms median | `gemini-3.1-flash-lite`; free-tier jitter up to ~1.3 s |
| End of user speech → first agent audio | ~1.5–2 s typical (best 1369 ms) | Bounded by free-tier LLM jitter |
| Under load (3 concurrent sessions) | 1369 / 1735 / 2071 ms | All replies correct |

Key techniques:

- **Eager end-of-turn overlap** — the LLM + TTS pipeline starts on Deepgram's `EagerEndOfTurn` (moderate confidence); audio is buffered server-side and flushed the instant `EndOfTurn` confirms — or discarded if the user keeps talking (`TurnResumed`). Unconfirmed audio never plays.
- **Client-side barge-in** — an RMS VAD inside the AudioWorklet detects overlapping speech in ~64 ms and kills playback locally, then tells the server to abort the TTS and LLM streams. A gate drops stale in-flight audio chunks (WebSocket ordering makes this race-free). Deepgram `StartOfTurn` acts as a server-side fallback.
- **Connection pre-warming** — the Deepgram socket and the LLM HTTPS connection are established when the browser connects, before anyone speaks.
- **Raw PCM end to end** — no codec latency; playback is scheduled gaplessly via Web Audio and can be stopped instantly.

## Setup

```bash
npm install
cp .env.example .env   # fill in your keys
npm run dev            # build + start, then open http://localhost:3000
```

Required keys (all have free tiers):

| Env var | Provider |
|---|---|
| `DEEPGRAM_API_KEY` | [Deepgram](https://console.deepgram.com/) — streaming STT (Flux) |
| `GEMINI_API_KEY` | [Google AI Studio](https://aistudio.google.com/apikey) — LLM |
| `ELEVENLABS_API_KEY` | [ElevenLabs](https://elevenlabs.io/) — streaming TTS (key needs the *Text to Speech* permission) |

Optional: `TTS_VOICE_ID` (defaults to a premade voice), `PORT` (default 3000).

## Security

- API keys live server-side only — never sent to the browser, never logged, never committed (`.env` is gitignored; history verified clean; built client bundle grepped for key patterns: zero hits).
- WebSocket hardening: Origin allowlist, **short-lived single-use session tokens** (`GET /session`, 60 s TTL), max 3 concurrent connections per IP, 1 MiB inbound message cap, unknown message types rejected, 5-minute idle timeout.
- **No PII in logs by default** — transcripts/replies/tool args are redacted unless `DEBUG_TRANSCRIPTS=1`. Audio is never logged.
- Per-session LLM rate limit (20 calls/min) caps cost abuse.
- Safe failure: every provider call has a timeout and retry cap; on unrecoverable failure the user hears a pre-cached spoken fallback line (or a tone if TTS itself is down) and the session ends cleanly — never a silent hang.
- Least-privilege tools: each tool does one job; no shell, no arbitrary URLs.
- Static file serving with path-traversal protection.

## Development log

Built in phases, each ending with a hard, measured check ([CLAUDE.md](CLAUDE.md) is the project spec):

| Phase | Delivered | Check result |
|---|---|---|
| 0 | Skeleton: TS build, WS server, health endpoint | Build + audit clean, WS connects |
| 1 | Audio uplink: AudioWorklet capture, 16 kHz PCM streaming | 90 frames / 5 s, all 1600 B |
| 2 | STT + endpointing: Deepgram Flux, turn events | 100% word accuracy; EoT gap 563–705 ms |
| 3 | LLM: Gemini streaming, abortable, history | "Four." correct; first token 552 ms median |
| 4 | Full voice loop: ElevenLabs TTS, eager overlap | Headline 1555 ms best (free-tier bound) |
| 5 | **Barge-in + turn state machine** | 8/8 stops at 64 ms, zero resumes |
| 6 | Tools mid-conversation (booking demo) | Correct tool + args, confirmation id spoken, recalled next turn |
| 7 | Safe failure: timeouts, fallbacks | All 3 providers killed → spoken fallback, structured log, clean end |
| 8 | Security + latency hardening | Full checklist pass; 0 audit vulns; 0 secrets in bundle; load-tested |

## License

[MIT](LICENSE)
