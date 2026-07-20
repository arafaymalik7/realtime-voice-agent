// config.ts — per-agent configuration. Today this is a single default read from
// env; it is structured as data (not hardcoded strings scattered across modules)
// so that multi-tenant, per-business config can be loaded from a database later
// without touching the STT/LLM/TTS modules.

export interface AgentConfig {
  /** Business the agent answers for — used in the persona. */
  businessName: string;
  /** Extra persona / behavior guidance appended to the base system prompt. */
  persona: string;
  /** IANA timezone the business operates in (affects "today"/"tomorrow"). */
  timezone: string;
  /** Bookable appointment slots offered by check_availability. */
  slots: string[];
  /** ElevenLabs voice id for this agent. */
  voiceId: string;
}

const DEFAULT_VOICE_ID = "EXAVITQu4vr4xnSDxMaL"; // Sarah (premade)
const DEFAULT_SLOTS = ["10:00", "11:30", "14:30", "16:00"];

/** The single default agent, sourced from env with sensible fallbacks. */
export function defaultAgentConfig(): AgentConfig {
  const slotsEnv = process.env.AGENT_SLOTS;
  return {
    businessName: process.env.AGENT_BUSINESS_NAME ?? "the clinic",
    persona:
      process.env.AGENT_PERSONA ??
      "You are warm, efficient, and never pushy. Keep the caller moving toward what they need.",
    timezone: process.env.AGENT_TIMEZONE ?? "UTC",
    slots: slotsEnv ? slotsEnv.split(",").map((s) => s.trim()) : DEFAULT_SLOTS,
    voiceId: process.env.TTS_VOICE_ID ?? DEFAULT_VOICE_ID,
  };
}

/**
 * Build the full system instruction for one request. The current date is
 * embedded per-call so "today"/"tomorrow" stay correct across a long session.
 */
export function buildSystemInstruction(config: AgentConfig, now: Date): string {
  // Resolve "today" in the business's timezone.
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: config.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const today = fmt.format(now); // YYYY-MM-DD
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: config.timezone,
    weekday: "long",
  }).format(now);

  return (
    `You are a friendly voice assistant on a phone-style call for ${config.businessName}. ` +
    "Reply in short, natural spoken sentences — no markdown, no lists, no emoji. " +
    "Be concise: one or two sentences unless the caller asks for more. " +
    `${config.persona} ` +
    `Today is ${weekday}, ${today}. ` +
    "You can book appointments. When the caller wants one: call check_availability " +
    "for the requested date first. If they named only a general time of day (morning, " +
    "afternoon), pick the matching open slot yourself and book it immediately — do not " +
    "ask them to choose. Always call book_appointment to actually book; never claim a " +
    "booking without it. After booking, read back the time and the confirmation code."
  );
}
