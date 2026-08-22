/**
 * Cascade / podcast TTS voices — qwen-audio-3.0-tts-plus system voices first.
 * CosyVoice ids stay accepted so old stored prefs still synthesize.
 */
export const COSYVOICE_PRESET_VOICES = [
  { voice: "longanlingxin", name: "龙安聆心·温暖共情" },
  { voice: "longanqian", name: "龙安谦" },
  { voice: "longanyang", name: "龙安洋·阳光男声" },
  { voice: "longanhuan", name: "龙安欢·元气女声" }
] as const;

export type CosyVoicePreset = (typeof COSYVOICE_PRESET_VOICES)[number];

const PRESET_IDS = new Set<string>(COSYVOICE_PRESET_VOICES.map((v) => v.voice));

/** Legacy / invalid ids seen in demos and old defaults → map to a verified preset. */
const VOICE_ALIASES: Record<string, string> = {
  longyuan_v3: "longanlingxin",
  longyuan: "longanlingxin",
  longanhuan_v3: "longanlingxin",
  "longanhuan_v3.6": "longanlingxin",
  "calm-host": "longanqian",
  "warm-interviewer": "longanlingxin",
  Ethan: "longanlingxin",
  ethan: "longanlingxin"
};

/**
 * Normalize a podcast/TTS voice id to a verified preset.
 * Unknown or empty values fall back to `fallback` (default longanlingxin).
 */
export function normalizeCosyVoiceId(raw: string | undefined | null, fallback = "longanlingxin"): string {
  const v = (raw ?? "").trim();
  if (!v) return PRESET_IDS.has(fallback) ? fallback : "longanlingxin";
  if (PRESET_IDS.has(v)) return v;
  const aliased = VOICE_ALIASES[v] ?? VOICE_ALIASES[v.toLowerCase()];
  if (aliased && PRESET_IDS.has(aliased)) return aliased;
  return PRESET_IDS.has(fallback) ? fallback : "longanlingxin";
}

/** token-plan qwen-audio-3.0-tts-plus currently speaks these; others 411. */
const QWEN_AUDIO_TTS_VOICE_FALLBACKS: Record<string, string> = {
  longanhuan: "longanlingxin",
  longanyang: "longanqian"
};

export function resolveQwenAudioTtsVoice(raw: string | undefined | null): string {
  const normalized = normalizeCosyVoiceId(raw);
  return QWEN_AUDIO_TTS_VOICE_FALLBACKS[normalized] ?? normalized;
}

export function pairQwenAudioTtsVoice(host: string): string {
  return resolveQwenAudioTtsVoice(host) === "longanqian" ? "longanlingxin" : "longanqian";
}
