import { describe, it, expect } from "vitest";
import { createExpressionStateDetector, type ExpressionStateInput } from "./expressionStateDetector";

function input(overrides: Partial<ExpressionStateInput> = {}): ExpressionStateInput {
  return {
    speechRate: 3.5,
    baselineSpeechRate: 3.5,
    energy: 0.3,
    baselineEnergy: 0.3,
    pitchTrend: "flat",
    currentSilenceMs: 200,
    pausePosition: "grammar_boundary",
    hasFilledPause: false,
    hasRepetition: false,
    hasFalseStart: false,
    hasVagueTerm: false,
    hasEmotionWord: false,
    samePointCount: 0,
    timeSinceLastGuidance: 5000,
    ...overrides,
  };
}

describe("createExpressionStateDetector", () => {
  it("returns fluent with baseline-calibrated fast enough speech and short pauses", () => {
    const detector = createExpressionStateDetector();
    const state = detector.evaluate(input());
    expect(state).toBe("fluent");
  });

  it("returns organizing when there are filled pauses but no vague terms or repetition", () => {
    const detector = createExpressionStateDetector();
    const state = detector.evaluate(input({
      hasFilledPause: true,
      pausePosition: "mid_clause",
      currentSilenceMs: 600,
    }));
    expect(state).toBe("organizing");
  });

  it("returns hesitating when vague terms, repetition or false starts appear with medium-long pause", () => {
    const detector = createExpressionStateDetector();
    const state = detector.evaluate(input({
      hasVagueTerm: true,
      currentSilenceMs: 600,
      pausePosition: "mid_clause",
    }));
    expect(state).toBe("hesitating");
  });

  it("returns hesitating on repetition even without vague terms", () => {
    const detector = createExpressionStateDetector();
    const state = detector.evaluate(input({
      hasRepetition: true,
      currentSilenceMs: 550,
      pausePosition: "mid_clause",
    }));
    expect(state).toBe("hesitating");
  });

  it("returns hesitating on false start", () => {
    const detector = createExpressionStateDetector();
    const state = detector.evaluate(input({
      hasFalseStart: true,
      currentSilenceMs: 500,
      pausePosition: "mid_clause",
    }));
    expect(state).toBe("hesitating");
  });

  it("returns fluent even with filled pauses if the pause is at a grammar boundary", () => {
    const detector = createExpressionStateDetector();
    const state = detector.evaluate(input({
      hasFilledPause: true,
      currentSilenceMs: 400,
      pausePosition: "grammar_boundary",
    }));
    expect(state).toBe("fluent");
  });

  it("returns circling when same point has been repeated 2+ times", () => {
    const detector = createExpressionStateDetector();
    const state = detector.evaluate(input({ samePointCount: 2 }));
    expect(state).toBe("circling");
  });

  it("returns emotional with high energy and emotion words", () => {
    const detector = createExpressionStateDetector();
    const state = detector.evaluate(input({
      hasEmotionWord: true,
      energy: 0.5,
      baselineEnergy: 0.3,
    }));
    expect(state).toBe("emotional");
  });

  it("returns emotional with emotion words and flat pitch", () => {
    const detector = createExpressionStateDetector();
    const state = detector.evaluate(input({
      hasEmotionWord: true,
      pitchTrend: "flat",
    }));
    expect(state).toBe("emotional");
  });

  it("returns concluding when pitch is falling and silence is long", () => {
    const detector = createExpressionStateDetector();
    const state = detector.evaluate(input({
      pitchTrend: "falling",
      currentSilenceMs: 900,
    }));
    expect(state).toBe("concluding");
  });

  it("updates baseline speech rate and energy across evaluations", () => {
    const detector = createExpressionStateDetector();
    // First call: establish baseline
    expect(detector.evaluate(input({ speechRate: 4, energy: 0.4 }))).toBe("fluent");
    // Second call: lower rate is still fluent (within 0.8× baseline range)
    expect(detector.evaluate(input({ speechRate: 3.3, energy: 0.35 }))).toBe("fluent");
  });
});
