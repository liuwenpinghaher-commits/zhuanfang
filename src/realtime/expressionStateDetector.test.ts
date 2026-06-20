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
    const state = detector.evaluate(input({
      speechRate: 3.5,
      baselineSpeechRate: 3.5,
      currentSilenceMs: 200,
      pausePosition: "grammar_boundary",
      hasRepetition: false,
      hasFalseStart: false,
    }));
    expect(state).toBe("fluent");
  });

  it("returns organizing when the fluent conditions are not all met after baseline", () => {
    // After baseline, speech drops below 0.8× — fluent fails, organizing is fallback
    const detector = createExpressionStateDetector();
    detector.evaluate(input({ speechRate: 4, energy: 0.4, pausePosition: "grammar_boundary" }));
    detector.evaluate(input({ speechRate: 4, energy: 0.4, pausePosition: "grammar_boundary" }));
    detector.evaluate(input({ speechRate: 4, energy: 0.4, pausePosition: "grammar_boundary" }));
    // Now baseline is ~4.0. Pass speechRate=2.0 (0.5× baseline) — fluent should fail.
    const state = detector.evaluate(input({
      speechRate: 2.0,
      currentSilenceMs: 200,
      pausePosition: "grammar_boundary",
      hasRepetition: false,
      hasFalseStart: false,
    }));
    expect(state).toBe("organizing");
  });

  it("returns organizing when there are filled pauses but no vague terms or repetition", () => {
    const detector = createExpressionStateDetector();
    const state = detector.evaluate(input({
      hasFilledPause: true,
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

  it("P2-15: baseline keeps adapting (EMA) and does not freeze after 3 frames", () => {
    const detector = createExpressionStateDetector();
    // Seed a fast baseline well past the old 3-frame freeze window (~4.0).
    for (let i = 0; i < 4; i++) {
      detector.evaluate(input({ speechRate: 4, energy: 0.4, pausePosition: "grammar_boundary" }));
    }
    // Sanity: against the (still-fast) baseline, a rate of 2.0 is below 0.8×4.0
    // (=3.2) → NOT fluent. This is exactly what the old frozen baseline would
    // have returned forever.
    expect(detector.evaluate(input({
      speechRate: 2.0, energy: 0.4, currentSilenceMs: 200, pausePosition: "grammar_boundary",
      hasRepetition: false, hasFalseStart: false,
    }))).toBe("organizing");

    // Now sustain the slower rate for many frames. With the OLD frozen-at-3
    // logic the baseline is locked at ~4.0 and 2.0 stays "organizing" forever.
    // With the EMA the baseline drifts down toward ~2.0.
    for (let i = 0; i < 80; i++) {
      detector.evaluate(input({ speechRate: 2.0, energy: 0.4, pausePosition: "grammar_boundary" }));
    }
    // After adaptation, the SAME rate 2.0 now clears 0.8× the *adapted* baseline
    // (~2.0 → 1.6) and reads fluent. The flip from "organizing" → "fluent" for an
    // unchanged input is the proof that the baseline is no longer frozen.
    const state = detector.evaluate(input({
      speechRate: 2.0, energy: 0.4, currentSilenceMs: 200, pausePosition: "grammar_boundary",
      hasRepetition: false, hasFalseStart: false,
    }));
    expect(state).toBe("fluent");
  });
});
