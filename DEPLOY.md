# Deploying the Realtime Voice Agent

The app is a single Node process (HTTP + WebSocket on one port) and ships with a
production `Dockerfile` and `fly.toml`. **HTTPS is mandatory** — browsers block
microphone access on plain HTTP, so the app is only usable over `https://`.

These instructions use [Fly.io](https://fly.io) (WebSocket-friendly, generous
free allowance), but any host that can run a container and terminate TLS works
(Railway, Render, a VM behind Caddy/nginx, etc.).

## Prerequisites

- A Fly.io account and [`flyctl`](https://fly.io/docs/flyctl/install/) installed
  (`fly auth login`).
- Your three provider keys (see [README](README.md#setup)).

## 1. Create the app (once)

From the repo root:

```bash
fly launch --no-deploy
```

Accept the existing `fly.toml` when prompted. This registers an app name (e.g.
`realtime-voice-agent`) and region, but does not deploy yet.

## 2. Set the public origin

The WebSocket layer only accepts connections whose `Origin` is allowlisted. Set
it to your Fly URL (swap in your actual app name):

```bash
fly config set env ALLOWED_ORIGINS="https://realtime-voice-agent.fly.dev"
```

`TRUST_PROXY=1` is already set in `fly.toml` so the per-IP connection cap uses
the real client IP behind Fly's proxy.

## 3. Set the provider secrets

Secrets are encrypted and never baked into the image:

```bash
fly secrets set \
  DEEPGRAM_API_KEY=... \
  GEMINI_API_KEY=... \
  ELEVENLABS_API_KEY=...
```

Optional: `LLM_PROVIDER=groq` + `GROQ_API_KEY=...` for lower latency,
`TTS_VOICE_ID=...`, `AGENT_BUSINESS_NAME=...`, etc. (see `.env.example`).

## 4. Deploy

```bash
fly deploy
```

CI already builds the Docker image on every push, so if CI is green the image
builds. Once deployed, open `https://<your-app>.fly.dev` and click **Start**.

## 5. Verify

```bash
curl https://<your-app>.fly.dev/health      # -> {"ok":true}
```

Then load the page, allow the mic, and speak — the state orb should move through
Listening → Thinking → Speaking and you should hear a reply.

## Scaling notes

- **WebSocket sessions are stateful** (per-connection turn state, STT/LLM/TTS
  streams). If you scale to multiple machines, a session must stay on the
  machine it started on — Fly's default routing keeps a WebSocket pinned to one
  machine, so this works out of the box. Do **not** put a round-robin load
  balancer in front of the WS without sticky sessions.
- In-memory state (session tokens, per-IP counts, agent bookings) is per-process
  and not shared across machines. Multi-machine or restart-durable state is the
  Postgres/Redis milestone on the [roadmap](README.md#roadmap).
- `auto_stop_machines` in `fly.toml` lets the app scale to zero when idle to save
  cost; the first request after idle pays a cold start.

## Other hosts

Any container host works — build with the provided `Dockerfile`, expose port
3000, terminate TLS in front, and set the same env vars (`ALLOWED_ORIGINS`,
`TRUST_PROXY=1` if behind a proxy, and the provider secrets).
