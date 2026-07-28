import { describe, expect, it } from "vitest";
import { decideCascadeTurn, shouldAcceptBargeIn } from "./cascadeTurnDecision";
import { assessTurnCompleteness } from "./turnCompleteness";

describe("shouldAcceptBargeIn", () => {
  it("rejects ultra-short blips", () => {
    expect(shouldAcceptBargeIn(50, 280)).toBe(false);
    expect(shouldAcceptBargeIn(300, 280)).toBe(true);
  });
});

describe("assessTurnCompleteness semantic EoT", () => {
  it("treats done phrases as complete", () => {
    expect(assessTurnCompleteness("我的观点大概就是这样")).toBe("complete");
    expect(assessTurnCompleteness("先这样")).toBe("complete");
  });
  it("still marks hanging connectives incomplete", () => {
    expect(assessTurnCompleteness("因为")).toBe("incomplete");
  });
});

describe("decideCascadeTurn", () => {
  it("responds on complete transcript after min pause", () => {
    const d = decideCascadeTurn({
      expressionState: "fluent",
      silenceMs: 800,
      completeness: "complete"
    });
    expect(d.action).toBe("respond");
  });
});
