# Kickoff prompt — paste this as your FIRST message to Claude Code

(Put `CLAUDE.md` in the project root first. Then start Claude Code in that folder and send the message below.)

---

Read `CLAUDE.md` in full before responding. It is the source of truth for this project — follow its WORKFLOW and priorities exactly.

Do not write any code yet.

Your first job is **Phase 0 only**. Before implementing it:

1. Confirm you've read CLAUDE.md and restate the project's single hardest part in one sentence, so I know we're aligned.
2. Verify current details you'll need soon by fetching the official docs for Deepgram streaming STT, the Anthropic Node SDK, and ElevenLabs streaming TTS. Do not code against them yet — just confirmGI the current model names, endpoints, and expected audio formats, and tell me anything that differs from what CLAUDE.md assumes.
3. Give me a short written plan for Phase 0: the files you'll create, the folder structure, the exact CHECK you'll run, and the commands I'll run to verify.

Then STOP and wait for my "go" before implementing. Do not plan past Phase 0.

Follow the phase rules for every phase after this: plan → wait for go → implement → run the CHECK → report the real number → replan on failure with a 3-attempt cap, then hand it to me.

Keep responses tight. No filler, no restating things I already know. When you need a decision from me, ask one clear question.
