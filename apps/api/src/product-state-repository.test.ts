import { describe, expect, it } from "vitest";
import { createInMemoryProductStateRepository } from "./product-state-repository";

describe("in-memory product state repository", () => {
  it("bumps revision on every replaceState", () => {
    const repo = createInMemoryProductStateRepository();
    const r0 = repo.getState().revision;
    const next = repo.replaceState(repo.getState());
    expect(next.revision).toBe(r0 + 1);
    const next2 = repo.replaceState(next);
    expect(next2.revision).toBe(r0 + 2);
  });
});
