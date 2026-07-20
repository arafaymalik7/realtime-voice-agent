import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultAgentConfig, buildSystemInstruction } from "../src/server/config";

test("defaultAgentConfig falls back to sane defaults with no env", () => {
  const saved = { ...process.env };
  delete process.env.AGENT_BUSINESS_NAME;
  delete process.env.AGENT_SLOTS;
  delete process.env.AGENT_TIMEZONE;
  delete process.env.TTS_VOICE_ID;
  try {
    const cfg = defaultAgentConfig();
    assert.equal(cfg.businessName, "the clinic");
    assert.deepEqual(cfg.slots, ["10:00", "11:30", "14:30", "16:00"]);
    assert.equal(cfg.timezone, "UTC");
    assert.ok(cfg.voiceId.length > 0);
  } finally {
    process.env = saved;
  }
});

test("defaultAgentConfig reads AGENT_SLOTS as a comma list", () => {
  const saved = process.env.AGENT_SLOTS;
  process.env.AGENT_SLOTS = "09:00, 12:00 ,15:00";
  try {
    assert.deepEqual(defaultAgentConfig().slots, ["09:00", "12:00", "15:00"]);
  } finally {
    if (saved === undefined) delete process.env.AGENT_SLOTS;
    else process.env.AGENT_SLOTS = saved;
  }
});

test("buildSystemInstruction embeds business name and today's date", () => {
  const cfg = {
    businessName: "Downtown Dental",
    persona: "Be brisk.",
    timezone: "UTC",
    slots: ["10:00"],
    voiceId: "x",
  };
  const s = buildSystemInstruction(cfg, new Date("2026-07-21T12:00:00Z"));
  assert.ok(s.includes("Downtown Dental"));
  assert.ok(s.includes("2026-07-21"));
  assert.ok(s.includes("Tuesday")); // 2026-07-21 is a Tuesday
  assert.ok(s.includes("Be brisk."));
  assert.ok(s.includes("book_appointment"));
});

test("buildSystemInstruction resolves the date in the agent's timezone", () => {
  const cfg = {
    businessName: "X",
    persona: "",
    timezone: "America/New_York",
    slots: [],
    voiceId: "x",
  };
  // 01:30 UTC on the 21st is still 21:30 on the 20th in New York.
  const s = buildSystemInstruction(cfg, new Date("2026-07-21T01:30:00Z"));
  assert.ok(s.includes("2026-07-20"), "should be the 20th in New York");
});
