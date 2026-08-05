import { describe, expect, it } from "vitest";
import { runAllLoopGoldenScenarios } from "./loop-golden";

describe("loop golden factory", () => {
  it("all loop scenarios pass via shipped domain path", () => {
    const results = runAllLoopGoldenScenarios();
    for (const r of results) {
      expect(r.pass, `${r.id}: ${r.detail}`).toBe(true);
    }
  });
});
