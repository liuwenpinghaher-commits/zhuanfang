/**
 * CosyVoice preset voices — single source of truth.
 *
 * These are the only voices VERIFIED to synthesize on cosyvoice-v3-plus.
 * Each entry is model-locked: add a voice only after spiking it green
 * (scripts/spike-tts-proxy-voice). An unverified entry is a 418/400 trap.
 */
export const COSYVOICE_PRESET_VOICES = [
  { voice: "longanyang", name: "龙安洋·阳光男声" },
  { voice: "longanhuan", name: "龙安欢·元气女声" },
] as const;

export type CosyVoicePreset = (typeof COSYVOICE_PRESET_VOICES)[number];

const PRESET_IDS = new Set<string>(COSYVOICE_PRESET_VOICES.map((v) => v.voice));

/** Legacy / invalid ids seen in demos and old defaults → map to a verified preset. */
const VOICE_ALIASES: Record<string, string> = {
  longyuan_v3: "longanhuan",
  longyuan: "longanhuan",
  "calm-host": "longanyang",
  "warm-interviewer": "longanhuan",
};

/**
 * Normalize a podcast/TTS voice id to a CosyVoice-v3-plus verified preset.
 * Unknown or empty values fall back to `fallback` (default longanhuan).
 */
export function normalizeCosyVoiceId(raw: string | undefined | null, fallback = "longanhuan"): string {
  const v = (raw ?? "").trim();
  if (!v) return PRESET_IDS.has(fallback) ? fallback : "longanhuan";
  if (PRESET_IDS.has(v)) return v;
  const aliased = VOICE_ALIASES[v] ?? VOICE_ALIASES[v.toLowerCase()];
  if (aliased && PRESET_IDS.has(aliased)) return aliased;
  return PRESET_IDS.has(fallback) ? fallback : "longanhuan";
}
