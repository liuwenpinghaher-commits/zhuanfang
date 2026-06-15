import { describe, expect, it } from "vitest";
import { createSilenceVadDetector, SILENCE_VAD_DETECTOR_ID } from "./silenceVadDetector";

const baseOptions = { silenceThresholdMs: 300, longPauseThresholdMs: 1500 };

describe("silenceVadDetector", () => {
  it("exposes a stable detector id", () => {
    const detector = createSilenceVadDetector(baseOptions);
    expect(detector.id).toBe(SILENCE_VAD_DETECTOR_ID);
  });

  it("returns guidance in 400-800ms silence window when assistant is not speaking", () => {
    const detector = createSilenceVadDetector(baseOptions);
    const result = detector.evaluate({
      inputLevel: 0.05,
      silenceMs: 500,
      isUserSpeaking: false,
      isAssistantSpeaking: false
    });
    expect(result.decision).toBe("guidance");
    expect(result.guidance?.kind).toBe("nudge");
    expect(result.guidance?.text).toBe("嗯");
  });

  it("does not return guidance when assistant is speaking", () => {
    const detector = createSilenceVadDetector(baseOptions);
    const result = detector.evaluate({
      inputLevel: 0.05,
      silenceMs: 500,
      isUserSpeaking: false,
      isAssistantSpeaking: true
    });
    expect(result.decision).not.toBe("guidance");
  });

  it("flags continue while user is actively speaking", () => {
    const detector = createSilenceVadDetector(baseOptions);
    const decision = detector.evaluate({
      inputLevel: 0.6,
      silenceMs: 0,
      isUserSpeaking: true,
      isAssistantSpeaking: false
    });
    expect(decision.decision).toBe("continue");
    expect(decision.confidence).toBeGreaterThan(0.5);
  });

  it("emits interruption when both speak", () => {
    const detector = createSilenceVadDetector(baseOptions);
    const decision = detector.evaluate({
      inputLevel: 0.4,
      silenceMs: 0,
      isUserSpeaking: true,
      isAssistantSpeaking: true
    });
    expect(decision.decision).toBe("interruption");
    expect(decision.confidence).toBeGreaterThan(0.5);
  });

  it("returns continue with low confidence inside short pause", () => {
    const detector = createSilenceVadDetector(baseOptions);
    const decision = detector.evaluate({
      inputLevel: 0.05,
      silenceMs: 200,
      isUserSpeaking: false,
      isAssistantSpeaking: false
    });
    expect(decision.decision).toBe("continue");
    expect(decision.confidence).toBeLessThanOrEqual(0.4);
  });

  it("returns continue with mid confidence between thresholds (outside guidance window)", () => {
    const detector = createSilenceVadDetector(baseOptions);
    // 1000ms is past the silence threshold but outside the 400-800ms guidance
    // window and below the long-pause threshold -> short-pause "continue".
    const decision = detector.evaluate({
      inputLevel: 0.05,
      silenceMs: 1000,
      isUserSpeaking: false,
      isAssistantSpeaking: false
    });
    expect(decision.decision).toBe("continue");
    expect(decision.reason).toContain("短停顿");
  });

  it("returns end_of_turn after long pause", () => {
    const detector = createSilenceVadDetector(baseOptions);
    const decision = detector.evaluate({
      inputLevel: 0.05,
      silenceMs: 2000,
      isUserSpeaking: false,
      isAssistantSpeaking: false
    });
    expect(decision.decision).toBe("end_of_turn");
    expect(decision.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it("clamps confidence to [0, 1]", () => {
    const detector = createSilenceVadDetector(baseOptions);
    const high = detector.evaluate({
      inputLevel: 5,
      silenceMs: 0,
      isUserSpeaking: true,
      isAssistantSpeaking: false
    });
    expect(high.confidence).toBeLessThanOrEqual(1);

    const low = detector.evaluate({
      inputLevel: -1,
      silenceMs: 100,
      isUserSpeaking: false,
      isAssistantSpeaking: false
    });
    expect(low.confidence).toBeGreaterThanOrEqual(0);
  });
});
