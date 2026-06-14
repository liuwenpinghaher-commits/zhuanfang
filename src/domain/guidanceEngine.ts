import type { GuidanceKind, RealtimeGuidanceDecision } from "./types";

export interface GuidanceEvalContext {
  partialTranscript: string;
  finalTranscript: string;
  silenceMs: number;
  isUserSpeaking: boolean;
  isAssistantSpeaking: boolean;
  turnCount: number;
  guidanceCountThisTurn: number;
  lastGuidanceTimestamp: string | null;
  blindspotCandidates: Array<{ concept: string; reason: string }>;
  recentAnchorWords: string[];
  guidanceBudget: {
    maxPerTurn: number;
    minIntervalMs: number;
    challengeBudget: number;
    challengeUsed: number;
  };
}

export function evaluateGuidance(ctx: GuidanceEvalContext): RealtimeGuidanceDecision | null {
  if (ctx.guidanceCountThisTurn >= ctx.guidanceBudget.maxPerTurn) return null;
  if (ctx.lastGuidanceTimestamp) {
    const elapsed = Date.now() - new Date(ctx.lastGuidanceTimestamp).getTime();
    if (elapsed < ctx.guidanceBudget.minIntervalMs) return null;
  }
  if (ctx.silenceMs < 400 || ctx.silenceMs > 1200) return null;
  if (ctx.isAssistantSpeaking) return null;

  const transcript = ctx.finalTranscript || ctx.partialTranscript;
  if (!transcript || transcript.length < 5) return null;

  const vagueAnchor = detectVagueAnchor(transcript);
  if (vagueAnchor) {
    return {
      kind: "anchor_probe",
      text: generateAnchorProbeText(vagueAnchor),
      anchor: vagueAnchor,
      reason: `检测到模糊锚点: "${vagueAnchor}"`,
      confidence: 0.82
    };
  }

  const emotionSignal = detectEmotionSignal(transcript);
  if (emotionSignal) {
    return {
      kind: "emotion_label",
      text: generateEmotionLabelText(emotionSignal),
      anchor: emotionSignal.word,
      reason: `检测到情感信号: ${emotionSignal.type}`,
      confidence: 0.75
    };
  }

  if (ctx.turnCount >= 2) {
    const contradiction = detectContradiction(transcript);
    if (contradiction && ctx.guidanceBudget.challengeUsed < ctx.guidanceBudget.challengeBudget) {
      return {
        kind: "contradiction",
        text: `你刚才说"${contradiction.previous}"，但现在提到"${contradiction.current}"，这两个好像不太一样？`,
        anchor: contradiction.current,
        reason: "检测到前后矛盾",
        confidence: 0.7
      };
    }
  }

  if (ctx.silenceMs >= 600 && ctx.silenceMs < 900 && ctx.guidanceCountThisTurn === 0) {
    return {
      kind: "nudge",
      text: "嗯",
      anchor: undefined,
      reason: "用户思考停顿，轻推延续",
      confidence: 0.6
    };
  }

  return null;
}

function detectVagueAnchor(text: string): string | null {
  const patterns = [
    /那个(东西|事|问题|人|决定|选择|时候|感觉|想法)/,
    /这个(东西|事|问题|人|决定|选择|时候|感觉|想法)/,
    /某种(程度|意义|方式|东西|感觉)/,
    /怎么说呢/,
    /反正就是/,
    /你懂的/,
    /那种(感觉|状态|情况)/,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[0];
  }
  return null;
}

function generateAnchorProbeText(anchor: string): string {
  if (anchor.includes("决定") || anchor.includes("选择")) {
    return `等一下，你说的"${anchor}"，当时是怎么做出这个决定的？`;
  }
  if (anchor.includes("感觉") || anchor.includes("状态")) {
    return `你说的"${anchor}"，能具体描述一下是什么样的吗？`;
  }
  return `等一下，你说的"${anchor}"具体是指？`;
}

interface EmotionSignal {
  type: "conflict" | "frustration" | "uncertainty" | "regret";
  word: string;
}

function detectEmotionSignal(text: string): EmotionSignal | null {
  if (text.includes("矛盾") || text.includes("纠结") || text.includes("两难")) {
    return { type: "conflict", word: "矛盾" };
  }
  if (text.includes("不知道") || text.includes("不确定") || text.includes("也许") || text.includes("可能吧")) {
    return { type: "uncertainty", word: "不确定" };
  }
  if (text.includes("烦") || text.includes("累") || text.includes("受不了") || text.includes("没办法")) {
    return { type: "frustration", word: "烦" };
  }
  if (text.includes("后悔") || text.includes("早知道") || text.includes("如果当初")) {
    return { type: "regret", word: "后悔" };
  }
  return null;
}

function generateEmotionLabelText(signal: EmotionSignal): string {
  switch (signal.type) {
    case "conflict": return "听起来你内心很矛盾";
    case "uncertainty": return "你好像也不太确定";
    case "frustration": return "这确实让人很疲惫";
    case "regret": return "你似乎有些遗憾";
  }
}

interface Contradiction {
  previous: string;
  current: string;
}

function detectContradiction(text: string): Contradiction | null {
  const butMatch = text.match(/(?:但是|不过|可是|然而|却)\s*(.{4,20}?)(?:[，。！？]|$)/);
  if (!butMatch) return null;
  const beforeBut = text.substring(0, text.indexOf(butMatch[0]));
  const positivePatterns = [/我觉得.{2,10}是/, /我认为/, /应该是/, /肯定是/, /一直是/];
  for (const pattern of positivePatterns) {
    const match = beforeBut.match(pattern);
    if (match) {
      return {
        previous: match[0].substring(0, 12),
        current: butMatch[1].substring(0, 12)
      };
    }
  }
  return null;
}
