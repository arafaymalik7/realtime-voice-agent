// fallback.ts — the "loud, safe failure" voice. The fallback line is synthesized
// ONCE at server startup and cached as raw PCM, so it can be played even when
// every provider is down mid-call. If ElevenLabs itself is unreachable at
// startup, a generated attention tone is cached instead (the client also shows
// the failure as text, so the user is never left guessing).

export const FALLBACK_LINE =
  "Sorry, I'm having trouble right now. Let me get a human to help you.";

const SAMPLE_RATE = 16000;

let cachedPcm: Buffer | null = null;
let cachedIsTone = false;

/** Three short 440 Hz beeps — the "TTS is down too" fallback for the fallback. */
function generateTonePcm(): Buffer {
  const beepSec = 0.18;
  const gapSec = 0.12;
  const total = Math.round(SAMPLE_RATE * (3 * beepSec + 2 * gapSec));
  const pcm = new Int16Array(total);
  for (let b = 0; b < 3; b++) {
    const start = Math.round(SAMPLE_RATE * b * (beepSec + gapSec));
    const len = Math.round(SAMPLE_RATE * beepSec);
    for (let i = 0; i < len; i++) {
      const env = Math.sin((Math.PI * i) / len); // fade in/out, no clicks
      pcm[start + i] = Math.round(Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE) * env * 0.3 * 0x7fff);
    }
  }
  return Buffer.from(pcm.buffer);
}

export async function initFallback(apiKey: string, voiceId: string): Promise<void> {
  if (apiKey) {
    try {
      const res = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=pcm_16000`,
        {
          method: "POST",
          headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
          body: JSON.stringify({ text: FALLBACK_LINE, model_id: "eleven_flash_v2_5" }),
          signal: AbortSignal.timeout(10_000),
        }
      );
      if (res.ok) {
        cachedPcm = Buffer.from(await res.arrayBuffer());
        cachedIsTone = false;
        return;
      }
      console.log(
        `[fallback] ElevenLabs synthesis failed (HTTP ${res.status}) — caching tone instead`
      );
    } catch (err) {
      console.log(
        `[fallback] ElevenLabs unreachable (${err instanceof Error ? err.message : err}) — caching tone instead`
      );
    }
  }
  cachedPcm = generateTonePcm();
  cachedIsTone = true;
}

export function getFallbackAudio(): { pcm: Buffer; durationMs: number; isTone: boolean } | null {
  if (!cachedPcm) return null;
  return {
    pcm: cachedPcm,
    durationMs: Math.round((cachedPcm.length / 2 / SAMPLE_RATE) * 1000),
    isTone: cachedIsTone,
  };
}
