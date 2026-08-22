import { describe, expect, it } from "vitest";
import { applyPvadDecisionBias, resolveEndpointingTuning } from "./pvadEndpointing";

describe("resolveEndpointingTuning", () => {
  it("semantic treats unpunctuated speech as respond-ready after energy has fallen", () => {
    const t = resolveEndpointingTuning({
      mode: "semantic",
      expressionState: "fluent",
      silenceMs: 900,
      completeness: "ambiguous",
      recentEnergy: 0.01,
      baseMinPauseMs: 600
    });
    expect(t.preferRespondOnAmbiguous).toBe(true);
  });

  it("silence mode keeps base pauses", () => {
    const t = resolveEndpointingTuning({
      mode: "silence",
      expressionState: "fluent",
      silenceMs: 700,
      completeness: "ambiguous",
      baseMinPauseMs: 600
    });
    expect(t.minPauseMs).toBe(600);
    expect(t.label).toBe("silence");
  });

  it("pvad-experimental shortens pause when concluding", () => {
    const t = resolveEndpointingTuning({
      mode: "pvad-experimental",
      expressionState: "concluding",
      silenceMs: 500,
      completeness: "complete",
      recentEnergy: 0.05,
      baseMinPauseMs: 600
    });
    expect(t.minPauseMs).toBeLessThan(600);
    expect(t.preferRespondOnAmbiguous).toBe(true);
    expect(t.label).toBe("pvad-experimental");
  });

  it("pvad-experimental lengthens pause when incomplete/circling", () => {
    const t = resolveEndpointingTuning({
      mode: "pvad-experimental",
      expressionState: "circling",
      silenceMs: 700,
      completeness: "incomplete",
      recentEnergy: 0.4,
      baseMinPauseMs: 600
    });
    expect(t.minPauseMs).toBeGreaterThan(600);
  });
});

describe("applyPvadDecisionBias", () => {
  it("promotes uncertain to respond when preferRespond", () => {
    expect(
      applyPvadDecisionBias("uncertain", {
        minPauseMs: 400,
        maxWaitMs: 8000,
        preferRespondOnAmbiguous: true,
        label: "pvad-experimental"
      })
    ).toBe("respond");
  });
});
