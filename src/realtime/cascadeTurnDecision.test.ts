import { describe, it, expect } from "vitest";
import { decideCascadeTurn } from "./cascadeTurnDecision";

describe("decideCascadeTurn", () => {
  const base = { expressionState: "fluent" as const, silenceMs: 1000, completeness: "ambiguous" as const };

  it("静默超过 maxWait → respond（安全网）", () => {
    expect(decideCascadeTurn({ ...base, silenceMs: 9000, maxWaitMs: 8000 }).action).toBe("respond");
  });

  it("停顿过短 → wait", () => {
    expect(decideCascadeTurn({ ...base, silenceMs: 300, minPauseMs: 600 }).action).toBe("wait");
  });

  it("emotional → backchannel", () => {
    expect(decideCascadeTurn({ ...base, expressionState: "emotional" }).action).toBe("backchannel");
  });

  it("circling → backchannel", () => {
    expect(decideCascadeTurn({ ...base, expressionState: "circling" }).action).toBe("backchannel");
  });

  it("completeness=complete → respond", () => {
    expect(decideCascadeTurn({ ...base, completeness: "complete" }).action).toBe("respond");
  });

  it("completeness=incomplete → wait", () => {
    expect(decideCascadeTurn({ ...base, completeness: "incomplete" }).action).toBe("wait");
  });

  it("completeness=ambiguous → uncertain（升 Layer 2）", () => {
    expect(decideCascadeTurn({ ...base, completeness: "ambiguous" }).action).toBe("uncertain");
  });

  it("每个决策都带 reason", () => {
    expect(decideCascadeTurn(base).reason.length).toBeGreaterThan(0);
  });
});
