import { describe, it, expect } from "vitest";
import { evaluateIntent } from "./interactionIntentEngine";
import type { ExpressionState, InteractionPreSignals } from "../domain/types";

function defaultSignals(): InteractionPreSignals {
  return {
    depthDirection: null,
    backchannelWhitelist: ["嗯", "对", "是的", "好"],
    interruptTriggers: ["不对", "不是", "等一下"],
    interruptSensitivity: "medium",
  };
}

function depthSignals(guidance: string): InteractionPreSignals {
  return {
    ...defaultSignals(),
    depthDirection: { concept: "产品方向", reason: "用户反复提及", guidance },
  };
}

describe("evaluateIntent — user speaking, AI listening", () => {
  it("returns backchannel/continue for fluent state", () => {
    const result = evaluateIntent({
      expressionState: "fluent",
      preSignals: defaultSignals(),
      isAssistantSpeaking: false,
      partialTranscript: "我最近在思考",
      audioDuration: 3000,
      guidanceCountThisTurn: 0,
      guidanceBudget: { maxPerTurn: 2, minIntervalMs: 5000 },
    });
    expect(result.intent).toBe("backchannel");
    expect(result.action).toBe("continue");
  });

  it("returns backchannel/continue for organizing state", () => {
    const result = evaluateIntent({
      expressionState: "organizing",
      preSignals: defaultSignals(),
      isAssistantSpeaking: false,
      partialTranscript: "",
      audioDuration: 2000,
      guidanceCountThisTurn: 0,
      guidanceBudget: { maxPerTurn: 2, minIntervalMs: 5000 },
    });
    expect(result.intent).toBe("backchannel");
    expect(result.action).toBe("continue");
  });

  it("returns backchannel/continue for concluding state", () => {
    const result = evaluateIntent({
      expressionState: "concluding",
      preSignals: defaultSignals(),
      isAssistantSpeaking: false,
      partialTranscript: "",
      audioDuration: 5000,
      guidanceCountThisTurn: 0,
      guidanceBudget: { maxPerTurn: 2, minIntervalMs: 5000 },
    });
    expect(result.intent).toBe("backchannel");
    expect(result.action).toBe("continue");
  });

  it("returns guidance/nudge with depth direction for hesitating state", () => {
    const result = evaluateIntent({
      expressionState: "hesitating",
      preSignals: depthSignals("你提到的那个方向，能具体说说吗？"),
      isAssistantSpeaking: false,
      partialTranscript: "那个...",
      audioDuration: 2000,
      guidanceCountThisTurn: 0,
      guidanceBudget: { maxPerTurn: 2, minIntervalMs: 5000 },
    });
    expect(result.intent).toBe("guidance");
    expect(result.action).toBe("nudge");
    expect(result.detail?.text).toBe("你提到的那个方向，能具体说说吗？");
  });

  it("returns guidance/nudge with nudge text for hesitating without depth direction", () => {
    const result = evaluateIntent({
      expressionState: "hesitating",
      preSignals: defaultSignals(),
      isAssistantSpeaking: false,
      partialTranscript: "嗯...我不知道",
      audioDuration: 1500,
      guidanceCountThisTurn: 0,
      guidanceBudget: { maxPerTurn: 2, minIntervalMs: 5000 },
    });
    expect(result.intent).toBe("guidance");
    expect(result.action).toBe("nudge");
    expect(result.detail?.text).toBe("嗯");
  });

  it("returns backchannel when hesitating but guidance budget is exhausted", () => {
    const result = evaluateIntent({
      expressionState: "hesitating",
      preSignals: defaultSignals(),
      isAssistantSpeaking: false,
      partialTranscript: "",
      audioDuration: 1000,
      guidanceCountThisTurn: 2,
      guidanceBudget: { maxPerTurn: 2, minIntervalMs: 5000 },
    });
    expect(result.intent).toBe("backchannel");
    expect(result.action).toBe("continue");
  });

  it("returns guidance with stage summary for circling", () => {
    const result = evaluateIntent({
      expressionState: "circling",
      preSignals: defaultSignals(),
      isAssistantSpeaking: false,
      partialTranscript: "",
      audioDuration: 3000,
      guidanceCountThisTurn: 0,
      guidanceBudget: { maxPerTurn: 2, minIntervalMs: 5000 },
    });
    expect(result.intent).toBe("guidance");
    expect(result.action).toBe("nudge");
    expect(result.detail?.text).toBe("到目前为止，核心是...");
  });

  it("returns guidance with empathy for emotional", () => {
    const result = evaluateIntent({
      expressionState: "emotional",
      preSignals: defaultSignals(),
      isAssistantSpeaking: false,
      partialTranscript: "我真的很烦",
      audioDuration: 2000,
      guidanceCountThisTurn: 0,
      guidanceBudget: { maxPerTurn: 2, minIntervalMs: 5000 },
    });
    expect(result.intent).toBe("guidance");
    expect(result.action).toBe("nudge");
    expect(result.detail?.text).toBe("这确实让人很疲惫");
  });
});

describe("evaluateIntent — AI speaking, user makes sound", () => {
  it("returns noise/ignore for very short low-energy sounds (< 200ms)", () => {
    const result = evaluateIntent({
      expressionState: "fluent",
      preSignals: defaultSignals(),
      isAssistantSpeaking: true,
      partialTranscript: "",
      audioDuration: 150,
      guidanceCountThisTurn: 0,
      guidanceBudget: { maxPerTurn: 2, minIntervalMs: 5000 },
    });
    expect(result.intent).toBe("noise");
    expect(result.action).toBe("ignore");
  });

  it("returns backchannel/continue for matched whitelist word (< 500ms)", () => {
    const result = evaluateIntent({
      expressionState: "fluent",
      preSignals: defaultSignals(),
      isAssistantSpeaking: true,
      partialTranscript: "嗯",
      audioDuration: 400,
      guidanceCountThisTurn: 0,
      guidanceBudget: { maxPerTurn: 2, minIntervalMs: 5000 },
    });
    expect(result.intent).toBe("backchannel");
    expect(result.action).toBe("continue");
  });

  it("returns interruption/stop for matched interrupt trigger", () => {
    const result = evaluateIntent({
      expressionState: "fluent",
      preSignals: defaultSignals(),
      isAssistantSpeaking: true,
      partialTranscript: "不对",
      audioDuration: 600,
      guidanceCountThisTurn: 0,
      guidanceBudget: { maxPerTurn: 2, minIntervalMs: 5000 },
    });
    expect(result.intent).toBe("interruption");
    expect(result.action).toBe("stop");
  });

  it("returns interruption/stop for long sentence with high sensitivity", () => {
    const sigs = { ...defaultSignals(), interruptSensitivity: "high" as const };
    const result = evaluateIntent({
      expressionState: "fluent",
      preSignals: sigs,
      isAssistantSpeaking: true,
      partialTranscript: "我觉得你说的不对我想补充一点",
      audioDuration: 1600,
      guidanceCountThisTurn: 0,
      guidanceBudget: { maxPerTurn: 2, minIntervalMs: 5000 },
    });
    expect(result.intent).toBe("interruption");
    expect(result.action).toBe("stop");
  });

  it("returns backchannel for long sentence with low sensitivity", () => {
    const sigs = { ...defaultSignals(), interruptSensitivity: "low" as const };
    const result = evaluateIntent({
      expressionState: "fluent",
      preSignals: sigs,
      isAssistantSpeaking: true,
      partialTranscript: "这个我补充一下",
      audioDuration: 1600,
      guidanceCountThisTurn: 0,
      guidanceBudget: { maxPerTurn: 2, minIntervalMs: 5000 },
    });
    expect(result.intent).toBe("backchannel");
    expect(result.action).toBe("continue");
  });
});
