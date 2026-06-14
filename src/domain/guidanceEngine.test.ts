import { describe, it, expect } from "vitest";
import { evaluateGuidance } from "./guidanceEngine";
import type { GuidanceEvalContext } from "./guidanceEngine";

function makeCtx(overrides: Partial<GuidanceEvalContext> = {}): GuidanceEvalContext {
  return {
    partialTranscript: "",
    finalTranscript: "",
    silenceMs: 600,
    isUserSpeaking: false,
    isAssistantSpeaking: false,
    turnCount: 1,
    guidanceCountThisTurn: 0,
    lastGuidanceTimestamp: null,
    blindspotCandidates: [],
    recentAnchorWords: [],
    guidanceBudget: {
      maxPerTurn: 2,
      minIntervalMs: 5000,
      challengeBudget: 3,
      challengeUsed: 0
    },
    ...overrides
  };
}

describe("evaluateGuidance", () => {
  it("在 600ms 静默时返回轻推引导", () => {
    const result = evaluateGuidance(makeCtx({
      partialTranscript: "我觉得这个项目...",
      silenceMs: 600
    }));
    expect(result?.kind).toBe("nudge");
    expect(result?.text).toBe("嗯");
  });

  it("检测到模糊锚点时返回 anchor_probe", () => {
    const result = evaluateGuidance(makeCtx({
      finalTranscript: "就是那个东西一直困扰我",
      silenceMs: 500
    }));
    expect(result?.kind).toBe("anchor_probe");
    expect(result?.anchor).toBe("那个东西");
  });

  it("检测到'这个决定'时返回 anchor_probe", () => {
    const result = evaluateGuidance(makeCtx({
      finalTranscript: "这个决定让我想了很久",
      silenceMs: 450
    }));
    expect(result?.kind).toBe("anchor_probe");
    expect(result?.anchor).toBe("这个决定");
  });

  it("检测到矛盾情绪时返回 emotion_label", () => {
    const result = evaluateGuidance(makeCtx({
      finalTranscript: "我很矛盾，不知道该不该继续",
      silenceMs: 500
    }));
    expect(result?.kind).toBe("emotion_label");
    expect(result?.text).toBe("听起来你内心很矛盾");
  });

  it("检测到不确定时返回 emotion_label", () => {
    const result = evaluateGuidance(makeCtx({
      finalTranscript: "我也不知道这样对不对",
      silenceMs: 500
    }));
    expect(result?.kind).toBe("emotion_label");
    expect(result?.text).toBe("你好像也不太确定");
  });

  it("超过每轮引导上限时不返回引导", () => {
    const result = evaluateGuidance(makeCtx({
      partialTranscript: "我觉得...",
      silenceMs: 600,
      guidanceCountThisTurn: 2
    }));
    expect(result).toBeNull();
  });

  it("间隔不足时不返回引导", () => {
    const result = evaluateGuidance(makeCtx({
      partialTranscript: "我觉得...",
      silenceMs: 600,
      lastGuidanceTimestamp: new Date().toISOString()
    }));
    expect(result).toBeNull();
  });

  it("静默时间不在引导窗口时不返回引导", () => {
    const result = evaluateGuidance(makeCtx({
      partialTranscript: "我觉得...",
      silenceMs: 200
    }));
    expect(result).toBeNull();
  });

  it("静默超过1200ms时不返回引导", () => {
    const result = evaluateGuidance(makeCtx({
      partialTranscript: "我觉得...",
      silenceMs: 1500
    }));
    expect(result).toBeNull();
  });

  it("AI正在说话时不返回引导", () => {
    const result = evaluateGuidance(makeCtx({
      partialTranscript: "我觉得...",
      silenceMs: 600,
      isAssistantSpeaking: true
    }));
    expect(result).toBeNull();
  });

  it("转写内容太短时不返回引导", () => {
    const result = evaluateGuidance(makeCtx({
      partialTranscript: "嗯",
      silenceMs: 600
    }));
    expect(result).toBeNull();
  });

  it("检测到'但是'矛盾时返回 contradiction", () => {
    const result = evaluateGuidance(makeCtx({
      finalTranscript: "我觉得应该是团队的问题，但是最近发现可能是我自己的问题",
      silenceMs: 500,
      turnCount: 3
    }));
    expect(result?.kind).toBe("contradiction");
  });
});
