/**
 * Strip parenthetical stage directions / asides from a reply before it is sent to TTS.
 *
 * The character interviewer model emits manner cues like 「（温和但明确地观察对方反应）」 or
 * 「（轻笑）」 to convey HOW it would say something. Those describe the host's behavior — they
 * must never be read aloud. This removes both full-width （…） and half-width (…) asides and
 * tidies the whitespace/punctuation left behind, so the spoken text is exactly the words the
 * interviewer actually says. Text without asides is returned unchanged.
 */
/** CosyVoice run-task prosody params (verified working on cosyvoice-v3-plus + system voices). */
export interface SpeechProsody {
  /** Speaking rate. 1 = normal; <1 slower, >1 faster. Kept in a natural interview band. */
  rate: number;
  /** Pitch. 1 = normal; <1 lower, >1 higher. */
  pitch: number;
  /** Volume. CosyVoice default is 50. */
  volume: number;
}

const NEUTRAL_PROSODY: SpeechProsody = { rate: 1, pitch: 1, volume: 50 };

// Emotion lexicon → prosody deltas. The character model's （…）asides describe HOW the
// interviewer would speak; we can't feed them as free-text to a system-voice TTS (it 428s),
// but we CAN translate the emotion into rate/pitch/volume (which CosyVoice honors). First
// matching family wins; everything is clamped to a natural interview range so the host never
// sounds cartoonish.
const EMOTION_RULES: Array<{ test: RegExp; rate: number; pitch: number; volume: number }> = [
  { test: /(轻笑|大笑|笑了|愉快|活泼|欢快|兴奋|雀跃|热情|俏皮|调侃|打趣)/, rate: 1.1, pitch: 1.12, volume: 55 },
  { test: /(好奇|疑惑|不解|惊讶|意外|挑眉|追问的语气)/, rate: 1.05, pitch: 1.1, volume: 52 },
  { test: /(急促|着急|紧张|快速|赶忙|催促)/, rate: 1.2, pitch: 1.05, volume: 55 },
  { test: /(严肃|郑重|认真|坚定|质问|挑战|犀利|尖锐)/, rate: 0.95, pitch: 0.9, volume: 52 },
  { test: /(温和|温柔|柔和|轻声|安慰|共情|关切|体贴|亲切|平和)/, rate: 0.9, pitch: 0.96, volume: 46 },
  { test: /(沉稳|沉静|沉思|思索|缓缓|缓慢|放慢|低沉|凝重|停顿)/, rate: 0.85, pitch: 0.93, volume: 50 }
];

const clamp = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value));

/**
 * Derive speaking prosody from the （…） manner asides in a reply. Returns neutral prosody when
 * there is no recognizable emotion, so a plain question is spoken normally. The aside TEXT is
 * NOT spoken (strip it separately with stripSpokenAsides) — only its emotion drives delivery.
 */
export function deriveSpeechProsody(text: string): SpeechProsody {
  const asides = [...text.matchAll(/（([^（）]*)）/g), ...text.matchAll(/\(([^()]*)\)/g)]
    .map((match) => match[1])
    .join(" ");
  if (!asides.trim()) {
    return { ...NEUTRAL_PROSODY };
  }
  const rule = EMOTION_RULES.find((candidate) => candidate.test.test(asides));
  if (!rule) {
    return { ...NEUTRAL_PROSODY };
  }
  return {
    rate: clamp(rule.rate, 0.8, 1.3),
    pitch: clamp(rule.pitch, 0.85, 1.2),
    volume: clamp(rule.volume, 20, 80)
  };
}

export function stripSpokenAsides(text: string): string {
  return text
    .replace(/（[^（）]*）/g, "") // full-width asides (non-nested)
    .replace(/\([^()]*\)/g, "") // half-width asides (non-nested)
    .replace(/[ \t]{2,}/g, " ") // collapse the gap a removed aside leaves between latin words
    .replace(/[ \t]+([，。！？、；：])/g, "$1") // drop space stranded before CJK punctuation
    .trim();
}
