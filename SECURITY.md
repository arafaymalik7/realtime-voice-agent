# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security vulnerabilities.

Instead, report privately via
[GitHub Security Advisories](https://github.com/arafaymalik7/realtime-voice-agent/security/advisories/new)
or email the maintainer at **arafaymalik7@gmail.com**.

Include, where possible:

- A description of the vulnerability and its impact.
- Steps to reproduce (a proof of concept if you have one).
- Affected version / commit.

You can expect an acknowledgement within a few days, and we'll keep you updated
as we work on a fix. Please give us reasonable time to remediate before any
public disclosure.

## Scope

This project handles live microphone audio, real-time transcripts (which are
personal data), and third-party API credentials. Areas of particular interest:

- **Credential exposure** — any path by which a provider API key could reach the
  browser, logs, or the git history.
- **WebSocket hardening** — Origin allowlist, session-token, per-IP connection
  cap, message-size cap bypasses.
- **Input validation** — malformed audio or JSON from the client that isn't
  safely rejected.
- **PII handling** — transcripts and audio must not be logged by default.

## Security measures already in place

- API keys are server-side only, loaded from `.env` (gitignored); the built
  client bundle is verified free of key patterns.
- WebSocket connections require a short-lived, single-use session token, pass an
  Origin allowlist, and are capped per IP; inbound messages are size-capped and
  type-validated.
- Transcripts and reply text are redacted from logs unless `DEBUG_TRANSCRIPTS=1`;
  audio is never logged.
- Static file serving is protected against path traversal.

See the [README security section](README.md#security) for the full list.
