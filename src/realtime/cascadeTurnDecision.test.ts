import { describe, expect, it } from "vitest";
import { decideCascadeTurn } from "./cascadeTurnDecision";

const base = { silenceMs: 1000, preSignals: null, maxWaitMs: 3500 } as const;
describe("decideCascadeTurn", () => {
  it("responds when the user concluded a thought", () => {
    expect(decideCascadeTurn({ ...base, expressionState: "concluding" }).action).toBe("respond");
  });
  it("waits (留白) when the user is still organizing / fluent / hesitating", () => {
    for (const s of ["organizing", "fluent", "hesitating"] as const) {
      expect(decideCascadeTurn({ ...base, expressionState: s }).action).toBe("wait");
    }
  });
  it("offers a brief backchannel when circling (not a full turn)", () => {
    const d = decideCascadeTurn({ ...base, expressionState: "circling" });
    expect(d.action).toBe("backchannel");
    expect((d.backchannelText ?? "").length).toBeGreaterThan(0);
  });
  it("max-wait safety: responds after long silence regardless of state", () => {
    expect(decideCascadeTurn({ ...base, expressionState: "organizing", silenceMs: 4000 }).action).toBe("respond");
  });
  it("never responds on a very short pause", () => {
    expect(decideCascadeTurn({ ...base, expressionState: "fluent", silenceMs: 200 }).action).toBe("wait");
  });
});
