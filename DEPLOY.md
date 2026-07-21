# Deploying the Realtime Voice Agent

The app is a single Node process (HTTP + WebSocket on one port) and ships with a
production `Dockerfile`. **HTTPS is mandatory** — browsers block microphone
access on plain HTTP, so the app is only usable over `https://`.

Two documented paths:

- **[Render](#render-free-no-card) — recommended, free, no credit card.** The
  service sleeps after ~15 min idle and cold-starts (~30–60s) on the next
  request; that wait lands on page load, not mid-call. Great for a shareable
  demo.
- **[Fly.io](#flyio-always-on-card-required) — always-on, ~$2–5/mo, card
  required.** Use this when a business relies on it 24/7 and cold starts aren't
  acceptable.

Both build from the same `Dockerfile`, so switching hosts is a config change,
not a rewrite.

---

## Render (free, no card)

Deployed as a **Blueprint** from [`render.yaml`](render.yaml) — reproducible,
version-controlled, and every push to the default branch auto-deploys.

### Steps

1. Sign up at [render.com](https://render.com) with your GitHub account (no card).
2. **New → Blueprint** → select this repository. Render reads `render.yaml`.
3. When prompted, paste the three secret values (they're marked `sync: false`, so
   they're stored encrypted in Render, never in git):
   - `DEEPGRAM_API_KEY`
   - `GEMINI_API_KEY`
   - `ELEVENLABS_API_KEY`
   - (optional) `LLM_PROVIDER=groq` + `GROQ_API_KEY` for lower latency
4. **Apply** — Render builds the Docker image and deploys. First build takes a
   few minutes. Confirm the service's instance type shows **Free** before
   applying. (If Render ever rejects `plan: free` in the blueprint, delete that
   line from `render.yaml`, push, and pick the Free instance in the dashboard.)

### After the first deploy

- Your URL is `https://voxdesk.onrender.com`, or a suffixed variant like
  `https://voxdesk-41jd.onrender.com` if the name collided. Either way it just
  works: the app reads Render's injected `RENDER_EXTERNAL_URL` and allowlists its
  own origin automatically — no manual `ALLOWED_ORIGINS` step.
- Verify: `curl https://<your-url>/health` → `{"ok":true}`
- Open the page, allow the mic, and speak.

`TRUST_PROXY=1` (set in `render.yaml`) makes the per-IP connection cap use the
real client IP behind Render's proxy (via `x-forwarded-for`).

---

## Fly.io (always-on, card required)

Config lives in [`fly.toml`](fly.toml). Requires
[`flyctl`](https://fly.io/docs/flyctl/install/) and a card on file (Fly's
anti-abuse gate, even within the free allowance).

```bash
fly auth login
fly apps create voxdesk --org personal
fly secrets set DEEPGRAM_API_KEY=... GEMINI_API_KEY=... ELEVENLABS_API_KEY=...
fly deploy
```

`fly.toml` already sets `ALLOWED_ORIGINS=https://voxdesk.fly.dev`,
`TRUST_PROXY=1`, a `/health` check, and `auto_stop_machines` (scale-to-zero to
save cost). Verify with `curl https://voxdesk.fly.dev/health`.

---

## Scaling notes (either host)

- **WebSocket sessions are stateful** (per-connection turn state, STT/LLM/TTS
  streams). A session must stay on the machine it started on. Both Render and Fly
  pin a WebSocket to one instance by default, so single-instance deploys work out
  of the box. Do **not** put a round-robin balancer in front of the WS without
  sticky sessions.
- In-memory state (session tokens, per-IP counts, bookings) is per-process and
  not shared across instances. Multi-instance or restart-durable state is the
  Postgres/Redis milestone on the [roadmap](README.md#roadmap).

## Other hosts

Any container host works — build the `Dockerfile`, expose port 3000 (or honor the
platform's `PORT` env, which the app already does), terminate TLS in front, and
set `ALLOWED_ORIGINS`, `TRUST_PROXY=1` (if behind a proxy), and the provider
secrets.
