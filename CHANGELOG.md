# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Project professionalism: EditorConfig, Prettier, ESLint (flat config), CI
  lint/format gates, `.gitattributes`, CONTRIBUTING, SECURITY, Code of Conduct,
  issue/PR templates.
- Unit test suite (27 tests via `node:test` + `tsx`): tools, config, the turn
  state machine (network-free, via injected fakes), and the Groq SSE parser.
  Wired into CI.
- Typed `AgentConfig` module — persona, business name, timezone, slots, and
  voice are now data (env-driven), the foundation for multi-tenant config.
- Provider-neutral `Llm` interface + a Groq adapter (`LLM_PROVIDER=groq`) as a
  low-latency alternative to Gemini.
- Deployment: multi-stage `Dockerfile` (non-root, healthcheck), `.dockerignore`,
  `fly.toml`, and a CI job that builds the image.
- Pre-commit hook (husky + lint-staged): auto-runs ESLint + Prettier on staged
  files so formatting issues can't reach CI.

### Changed

- Rebuilt the browser UI: chat-bubble transcript, animated state orb, latency
  stat tiles, tool-call rows, connection/mic status — theme-aware (light/dark).

### Fixed

- Raised per-session LLM rate limit (20 → 60/min) so the eager-overlap turn
  design no longer trips it during normal conversation.
- Rate-limit hits now surface as a soft notice instead of an error status.
- Session-close race: late Deepgram turn events after a session ends no longer
  drive the state machine or start new provider calls.

## [0.1.0] — 2026-07 — Definition of Done

The core voice agent, built in eight phased milestones (see the tagged commits
`phase-0` … `phase-8`).

### Added

- **Phase 0** — Node + TypeScript skeleton, `ws` server, static page, health
  endpoint, env scaffolding.
- **Phase 1** — Browser mic capture via AudioWorklet, 16 kHz linear16
  resampling, binary WebSocket streaming.
- **Phase 2** — Deepgram Flux streaming STT with model-integrated turn detection
  (100% word accuracy; end-of-turn gap 563–705 ms).
- **Phase 3** — Streaming LLM (Gemini `gemini-3.1-flash-lite`), abortable
  mid-stream, client-side history (first token ~552 ms median).
- **Phase 4** — Full voice loop with ElevenLabs Flash TTS, eager-end-of-turn
  overlap (best headline 1555 ms).
- **Phase 5** — Barge-in + turn state machine: client-side VAD stops agent audio
  in 64 ms (8/8), zero resumes.
- **Phase 6** — Tools mid-conversation: `check_availability` + `book_appointment`
  via Gemini function calling.
- **Phase 7** — Safe failure: cached spoken fallback, per-provider timeouts and
  retry caps, structured errors, clean session end.
- **Phase 8** — Security + latency hardening: single-use session tokens, per-IP
  connection caps, LLM rate limiting, idle timeout, PII-redacted logs.

[Unreleased]: https://github.com/arafaymalik7/realtime-voice-agent/compare/phase-8...HEAD
[0.1.0]: https://github.com/arafaymalik7/realtime-voice-agent/releases/tag/phase-8
