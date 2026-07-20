# Contributing

Thanks for your interest in improving the Realtime Voice Agent. This document
covers how to get set up, the conventions the project follows, and how to
propose changes.

## Getting started

```bash
git clone https://github.com/arafaymalik7/realtime-voice-agent.git
cd realtime-voice-agent
npm install
cp .env.example .env   # add your provider keys
npm run dev            # build + start, then open http://localhost:3000
```

You'll need free-tier API keys for the three providers — see the
[README](README.md#setup) for where to get each.

## Project layout

| Path                        | Responsibility                                             |
| --------------------------- | ---------------------------------------------------------- |
| `src/server/stt.ts`         | Speech-to-text (Deepgram Flux) — audio in, turn events out |
| `src/server/turn.ts`        | Turn state machine — the core of the project               |
| `src/server/llm.ts`         | LLM streaming + tool calling                               |
| `src/server/tts.ts`         | Text-to-speech (ElevenLabs)                                |
| `src/server/tools.ts`       | Agent tools (defined I/O, no side effects)                 |
| `src/server/index.ts`       | HTTP/WS server + wiring                                    |
| `src/client/main.ts`        | Browser: mic capture, playback, barge-in, UI               |
| `public/worklet/capture.js` | AudioWorklet: resampling + voice-activity detection        |

Each provider lives behind a small interface so it can be swapped in one file —
please keep that boundary intact when adding features.

## Before you open a PR

Run the same checks CI runs:

```bash
npm run lint          # ESLint
npm run format:check  # Prettier
npm run build         # tsc (server + client)
npm test              # unit tests
npm audit --audit-level=high
```

`npm run format` auto-fixes formatting.

## Conventions

- **TypeScript, strict mode.** No new `any` without a comment explaining why.
- **Commit messages:** [Conventional Commits](https://www.conventionalcommits.org/)
  (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`, `style:`).
- **Comments** explain _why_, not _what_ — state constraints the code can't show.
- **Never commit secrets.** Keys live in `.env` (gitignored). The client bundle
  must never contain a key — CI-adjacent checks grep for this.
- **Latency is a feature.** If a change adds latency to the turn loop, call it
  out in the PR and, where possible, measure it.

## Reporting bugs / requesting features

Use the issue templates. For anything security-related, follow
[SECURITY.md](SECURITY.md) instead of opening a public issue.
