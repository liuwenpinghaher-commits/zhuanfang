import { describe, expect, it } from "vitest";
import { decideTurn } from "./turnEngine";

describe("decideTurn", () => {
  it("pvad-experimental prefers respond when concluding", () => {
    const d = decideTurn({
      mode: "pvad-experimental",
      expressionState: "concluding",
      silenceMs: 500,
      completeness: "complete",
      recentEnergy: 0.05,
      baseMinPauseMs: 600
    });
    expect(d.action).toBe("respond");
    expect(d.minPauseMs).toBeLessThan(600);
  });

  it("silence mode waits under min pause", () => {
    const d = decideTurn({
      mode: "silence",
      expressionState: "fluent",
      silenceMs: 200,
      completeness: "ambiguous",
      baseMinPauseMs: 600
    });
    expect(d.action).toBe("wait");
  });
});
