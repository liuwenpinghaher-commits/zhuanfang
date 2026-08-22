/** Voices that actually speak on token-plan qwen-audio-3.0-tts-plus. */
export const QWEN_AUDIO_SPEAKING_VOICES = [
  { voice: "longanlingxin", name: "龙安聆心·温暖共情" },
  { voice: "longanqian", name: "龙安谦" }
] as const;

const SPEAKING_IDS = new Set<string>(QWEN_AUDIO_SPEAKING_VOICES.map((item) => item.voice));

const KNOWN_INVALID_GUEST_IDS = new Set(["warm-interviewer", "calm-host", "local-demo"]);

export function isQwenAudioSpeakingVoice(id: string): boolean {
  return SPEAKING_IDS.has(id.trim());
}

/** Pairing identity only — never write this back onto episode.voice. */
export function podcastSpeakingIdentity(host: string): "longanlingxin" | "longanqian" {
  const v = host.trim();
  if (v === "longanqian" || v === "longanyang") return "longanqian";
  return "longanlingxin";
}

export function pairPodcastGuestVoice(host: string): string {
  return podcastSpeakingIdentity(host) === "longanqian" ? "longanlingxin" : "longanqian";
}

export function clampPodcastGuestVoice(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const value = raw.trim();
  if (!value || KNOWN_INVALID_GUEST_IDS.has(value)) return undefined;
  return value;
}

export function podcastVoiceSelectOptions(current: string): Array<{ voice: string; name: string }> {
  const base = QWEN_AUDIO_SPEAKING_VOICES.map((item) => ({ voice: item.voice, name: item.name }));
  const id = current.trim();
  if (id && !base.some((item) => item.voice === id)) {
    return [{ voice: id, name: `${id}（现网可能改用聆心/谦出声）` }, ...base];
  }
  return base;
}
