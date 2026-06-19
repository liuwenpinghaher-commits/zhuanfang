/**
 * CosyVoice preset voices — single source of truth.
 *
 * These are the only voices VERIFIED to synthesize on cosyvoice-v3-plus.
 * Each entry is model-locked: add a voice only after spiking it green
 * (scripts/spike-tts-proxy-voice). An unverified entry is a 418 trap.
 */
export const COSYVOICE_PRESET_VOICES = [
  { voice: "longanyang", name: "龙安洋·阳光男声" },
  { voice: "longanhuan", name: "龙安欢·元气女声" },
] as const;

export type CosyVoicePreset = (typeof COSYVOICE_PRESET_VOICES)[number];
