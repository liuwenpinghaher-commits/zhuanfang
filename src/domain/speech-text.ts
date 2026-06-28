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
  { test: /(轻笑|大笑|笑了|愉快|活泼|欢快|兴奋|雀跃|热情|俏皮|调侃|打趣|欣喜|开心)/, rate: 1.1, pitch: 1.12, volume: 55 },
  { test: /(好奇|疑惑|不解|惊讶|意外|挑眉|追问的语气|惊叹|讶异)/, rate: 1.05, pitch: 1.1, volume: 52 },
  { test: /(急促|着急|紧张|快速|赶忙|催促|焦急)/, rate: 1.2, pitch: 1.05, volume: 55 },
  { test: /(严肃|郑重|认真|坚定|质问|挑战|犀利|尖锐|斩钉截铁)/, rate: 0.95, pitch: 0.9, volume: 52 },
  { test: /(鼓励|肯定|笃定|赞许|认可|支持的语气)/, rate: 1.0, pitch: 1.02, volume: 54 },
  { test: /(温和|温柔|柔和|轻声|安慰|共情|关切|体贴|亲切|平和|柔声)/, rate: 0.9, pitch: 0.96, volume: 46 },
  { test: /(悲伤|低落|遗憾|惋惜|沉重|哀伤|失落|叹息)/, rate: 0.85, pitch: 0.9, volume: 44 },
  { test: /(迟疑|犹豫|斟酌|为难|踌躇)/, rate: 0.9, pitch: 0.97, volume: 48 },
  { test: /(沉稳|沉静|沉思|思索|缓缓|缓慢|放慢|低沉|凝重|停顿)/, rate: 0.85, pitch: 0.93, volume: 50 }
];

const clamp = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value));

// 无 （…）asides 时,从文本本身的句式/标点/关键词派生交流语气——让纯陈述/问句不再单调地 neutral。
// 首个命中者胜;deltas 落在自然访谈区间(deriveSpeechProsody 末尾统一 clamp)。
const SEMANTIC_RULES: Array<{ test: (t: string) => boolean; rate: number; pitch: number; volume: number }> = [
  { test: (t) => /[！!]\s*$/.test(t), rate: 1.08, pitch: 1.06, volume: 54 },                          // 感叹:热情/强调
  { test: (t) => /[？?]\s*$/.test(t), rate: 1.0, pitch: 1.07, volume: 51 },                           // 问句:好奇邀请,轻升调
  { test: (t) => /(…|\.{3,}|沉默|想一想|慢慢说)/.test(t), rate: 0.86, pitch: 0.95, volume: 48 },      // 留白:放慢沉思
  { test: (t) => /(理解|明白|不容易|辛苦|担心|害怕|感受|陪着你|没关系|慢慢来)/.test(t), rate: 0.9, pitch: 0.98, volume: 47 }, // 共情:温和
  { test: (t) => /(其实|关键|核心|本质|重点是|真正)/.test(t), rate: 0.95, pitch: 1.0, volume: 53 },   // 点题:略强调放稳
  { test: (t) => t.replace(/[^，、,]/g, "").length >= 3 && t.length <= 30, rate: 1.06, pitch: 1.02, volume: 52 }, // 短句多停顿:略快
  { test: (t) => t.length >= 40, rate: 0.94, pitch: 0.98, volume: 50 }                                // 长陈述:沉稳放缓
];

function deriveFromTextSemantics(text: string): SpeechProsody {
  const rule = SEMANTIC_RULES.find((candidate) => candidate.test(text.trim()));
  if (!rule) return { ...NEUTRAL_PROSODY };
  return { rate: clamp(rule.rate, 0.8, 1.3), pitch: clamp(rule.pitch, 0.85, 1.2), volume: clamp(rule.volume, 20, 80) };
}

/**
 * Derive speaking prosody from the （…） manner asides in a reply. Returns neutral prosody when
 * there is no recognizable emotion, so a plain question is spoken normally. The aside TEXT is
 * NOT spoken (strip it separately with stripSpokenAsides) — only its emotion drives delivery.
 */
export function deriveSpeechProsody(text: string): SpeechProsody {
  const asides = [...text.matchAll(/（([^（）]*)）/g), ...text.matchAll(/\(([^()]*)\)/g)]
    .map((match) => match[1])
    .join(" ");
  // ① （…）manner asides 情绪优先——角色模型显式表达的语气,最权威。
  if (asides.trim()) {
    const rule = EMOTION_RULES.find((candidate) => candidate.test.test(asides));
    if (rule) {
      return {
        rate: clamp(rule.rate, 0.8, 1.3),
        pitch: clamp(rule.pitch, 0.85, 1.2),
        volume: clamp(rule.volume, 20, 80)
      };
    }
  }
  // ② 无 asides / asides 无匹配 → 从文本句式语义派生,让纯文本也有自然语气(不再单调 neutral)。
  return deriveFromTextSemantics(text);
}

export function stripSpokenAsides(text: string): string {
  return text
    .replace(/（[^（）]*）/g, "") // full-width asides (non-nested)
    .replace(/\([^()]*\)/g, "") // half-width asides (non-nested)
    .replace(/[ \t]{2,}/g, " ") // collapse the gap a removed aside leaves between latin words
    .replace(/[ \t]+([，。！？、；：])/g, "$1") // drop space stranded before CJK punctuation
    .trim();
}
