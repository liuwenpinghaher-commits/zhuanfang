import { describe, it, expect } from "vitest";
import { evaluateIntent } from "./interactionIntentEngine";
import type { InteractionPreSignals } from "../domain/types";

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

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    expressionState: "fluent",
    preSignals: defaultSignals(),
    isAssistantSpeaking: false,
    partialTranscript: "",
    audioDuration: 0,
    energy: 0.3,
    guidanceCountThisTurn: 0,
    timeSinceLastGuidance: 10000,
    guidanceEnabled: true,
    guidanceBudget: { maxPerTurn: 2, minIntervalMs: 5000 },
    ...overrides,
  } as Parameters<typeof evaluateIntent>[0];
}

describe("evaluateIntent — user speaking, AI listening", () => {
  it("returns backchannel/continue for fluent state", () => {
    const result = evaluateIntent(baseInput({ expressionState: "fluent" }));
    expect(result.intent).toBe("backchannel");
    expect(result.action).toBe("continue");
  });

  it("returns backchannel/continue for organizing state", () => {
    const result = evaluateIntent(baseInput({ expressionState: "organizing" }));
    expect(result.intent).toBe("backchannel");
    expect(result.action).toBe("continue");
  });

  it("returns backchannel/continue for concluding state", () => {
    const result = evaluateIntent(baseInput({ expressionState: "concluding" }));
    expect(result.intent).toBe("backchannel");
    expect(result.action).toBe("continue");
  });

  it("returns guidance/nudge with depth direction for hesitating state", () => {
    const result = evaluateIntent(baseInput({
      expressionState: "hesitating",
      preSignals: depthSignals("你提到的那个方向，能具体说说吗？"),
    }));
    expect(result.intent).toBe("guidance");
    expect(result.action).toBe("nudge");
    expect(result.detail?.text).toBe("你提到的那个方向，能具体说说吗？");
  });

  it("returns guidance/nudge with nudge text for hesitating without depth direction", () => {
    const result = evaluateIntent(baseInput({ expressionState: "hesitating" }));
    expect(result.intent).toBe("guidance");
    expect(result.action).toBe("nudge");
    expect(result.detail?.text).toBe("嗯");
  });

  it("returns backchannel when hesitating but guidance budget is exhausted", () => {
    const result = evaluateIntent(baseInput({
      expressionState: "hesitating",
      guidanceCountThisTurn: 2,
    }));
    expect(result.intent).toBe("backchannel");
    expect(result.action).toBe("continue");
  });

  it("returns backchannel when guidance is too soon after last guidance", () => {
    const result = evaluateIntent(baseInput({
      expressionState: "hesitating",
      timeSinceLastGuidance: 1000,
    }));
    expect(result.intent).toBe("backchannel");
    expect(result.action).toBe("continue");
  });

  it("returns backchannel when guidanceEnabled is false", () => {
    const result = evaluateIntent(baseInput({
      expressionState: "hesitating",
      preSignals: depthSignals("能具体说说吗？"),
      guidanceEnabled: false,
    }));
    expect(result.intent).toBe("backchannel");
    expect(result.action).toBe("continue");
  });

  it("returns guidance with stage summary for circling", () => {
    const result = evaluateIntent(baseInput({ expressionState: "circling" }));
    expect(result.intent).toBe("guidance");
    expect(result.action).toBe("nudge");
    expect(result.detail?.text).toBe("到目前为止，核心是...");
  });

  it("returns guidance with empathy for emotional", () => {
    const result = evaluateIntent(baseInput({ expressionState: "emotional" }));
    expect(result.intent).toBe("guidance");
    expect(result.action).toBe("nudge");
    expect(result.detail?.text).toBe("这确实让人很疲惫");
  });
});

describe("evaluateIntent — AI speaking, user makes sound", () => {
  function aiInput(overrides: Record<string, unknown> = {}) {
    return baseInput({ isAssistantSpeaking: true, ...overrides });
  }

  it("returns noise/ignore for very short low-energy sounds", () => {
    const result = evaluateIntent(aiInput({ audioDuration: 150, energy: 0.05 }));
    expect(result.intent).toBe("noise");
    expect(result.action).toBe("ignore");
  });

  it("returns backchannel for short high-energy sounds (not noise)", () => {
    const result = evaluateIntent(aiInput({ audioDuration: 150, energy: 0.3, partialTranscript: "嗯" }));
    expect(result.intent).toBe("backchannel");
    expect(result.action).toBe("continue");
  });

  it("returns backchannel/continue for matched whitelist word", () => {
    const result = evaluateIntent(aiInput({ audioDuration: 400, partialTranscript: "嗯" }));
    expect(result.intent).toBe("backchannel");
    expect(result.action).toBe("continue");
  });

  it("returns interruption/stop for matched interrupt trigger", () => {
    const result = evaluateIntent(aiInput({ audioDuration: 600, partialTranscript: "不对" }));
    expect(result.intent).toBe("interruption");
    expect(result.action).toBe("stop");
  });

  it("returns interruption/stop for long sentence with high sensitivity", () => {
    const sigs = { ...defaultSignals(), interruptSensitivity: "high" as const };
    const result = evaluateIntent(aiInput({ preSignals: sigs, audioDuration: 1600, partialTranscript: "我觉得你说的不对" }));
    expect(result.intent).toBe("interruption");
    expect(result.action).toBe("stop");
  });

  it("returns backchannel for long sentence with low sensitivity", () => {
    const sigs = { ...defaultSignals(), interruptSensitivity: "low" as const };
    const result = evaluateIntent(aiInput({ preSignals: sigs, audioDuration: 1600, partialTranscript: "这个我补充一下" }));
    expect(result.intent).toBe("backchannel");
    expect(result.action).toBe("continue");
  });
});
