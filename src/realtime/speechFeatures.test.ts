import { describe, expect, it } from "vitest";
import {
  computeSpeechRate,
  countSamePoint,
  createSpeechFeatureTracker,
  detectPausePosition,
  pitchTrendFromSeries,
  spectralCentroid
} from "./speechFeatures";

describe("computeSpeechRate", () => {
  it("returns chars/sec from transcript growth", () => {
    // "你好世界你们他她" (8) minus "你好" (2) = 6 new chars over 2s -> 3 chars/sec
    expect(computeSpeechRate("你好", 1000, "你好世界你们他她", 3000)).toBeCloseTo(3, 5);
  });

  it("returns null on no forward progress (turn reset)", () => {
    expect(computeSpeechRate("你好世界", 1000, "新", 2000)).toBeNull();
    expect(computeSpeechRate("你好", 1000, "你好", 2000)).toBeNull();
  });

  it("returns null on non-positive dt", () => {
    expect(computeSpeechRate("你", 2000, "你好世界", 2000)).toBeNull();
  });
});

describe("detectPausePosition", () => {
  it("detects grammar boundary on trailing punctuation", () => {
    expect(detectPausePosition("我觉得这件事很重要。")).toBe("grammar_boundary");
    expect(detectPausePosition("然后呢，")).toBe("grammar_boundary");
  });
  it("detects mid-clause when ending on a word", () => {
    expect(detectPausePosition("我觉得那个")).toBe("mid_clause");
  });
  it("detects sentence start when empty", () => {
    expect(detectPausePosition("   ")).toBe("sentence_start");
  });
});

describe("countSamePoint", () => {
  it("is 0 when no clause repeats", () => {
    expect(countSamePoint("我想换工作。其实我不缺钱。怕失去归属感。")).toBe(0);
  });
  it("counts extra repeats of the same clause (circling)", () => {
    // "我没办法放手" appears 3x -> 2 extra repetitions
    expect(countSamePoint("我没办法放手。我没办法放手。我没办法放手。")).toBe(2);
    // appears 2x -> 1 extra repetition
    expect(countSamePoint("我没办法放手。然后呢什么的。我没办法放手。")).toBe(1);
  });
  it("ignores very short fragments", () => {
    expect(countSamePoint("嗯。嗯。对。对。")).toBe(0);
  });
});

describe("spectralCentroid", () => {
  it("is 0 for a silent (all-zero) frame", () => {
    expect(spectralCentroid([0, 0, 0, 0], 16000)).toBe(0);
  });
  it("is higher when energy is concentrated in high bins", () => {
    const low = spectralCentroid([10, 5, 1, 0, 0, 0, 0, 0], 16000);
    const high = spectralCentroid([0, 0, 0, 0, 0, 1, 5, 10], 16000);
    expect(high).toBeGreaterThan(low);
  });
});

describe("pitchTrendFromSeries", () => {
  it("returns flat with too few points", () => {
    expect(pitchTrendFromSeries([100, 110])).toBe("flat");
  });
  it("detects rising", () => {
    expect(pitchTrendFromSeries([100, 100, 100, 200, 210, 220])).toBe("rising");
  });
  it("detects falling", () => {
    expect(pitchTrendFromSeries([220, 210, 205, 110, 105, 100])).toBe("falling");
  });
  it("detects flat when roughly stable", () => {
    expect(pitchTrendFromSeries([200, 201, 199, 200, 202, 198])).toBe("flat");
  });
});

describe("createSpeechFeatureTracker", () => {
  it("learns a real speech rate and computes features", () => {
    const tracker = createSpeechFeatureTracker();
    tracker.onTranscript("我", 1000); // first sample skipped (no prior ts)
    tracker.onTranscript("我觉得", 2000); // +2 chars / 1s = 2/s
    tracker.onTranscript("我觉得这个那个", 3000); // +4 chars / 1s = 4/s
    const features = tracker.features(3000, "我觉得这个那个");
    expect(features.speechRate).toBeGreaterThan(0);
    expect(features.baselineSpeechRate).toBeGreaterThan(0);
    expect(features.pausePosition).toBe("mid_clause");
  });

  it("reports time since last guidance", () => {
    const tracker = createSpeechFeatureTracker();
    expect(tracker.features(5000, "").timeSinceLastGuidance).toBe(99999);
    tracker.markGuidance(5000);
    expect(tracker.features(7000, "").timeSinceLastGuidance).toBe(2000);
  });

  it("surfaces circling via samePointCount", () => {
    const tracker = createSpeechFeatureTracker();
    const text = "我没办法放手。我没办法放手。我没办法放手。";
    expect(tracker.features(1000, text).samePointCount).toBe(2);
  });
});
