import { describe, expect, it } from "vitest";
import { createLlmBudget } from "./llm-budget";

describe("llm budget", () => {
  it("allows up to N calls per session then blocks", () => {
    const b = createLlmBudget({ maxCallsPerSession: 2 });
    expect(b.tryConsume("s1")).toBe(true);
    expect(b.tryConsume("s1")).toBe(true);
    expect(b.tryConsume("s1")).toBe(false); // 3rd blocked
    expect(b.tryConsume("s2")).toBe(true);  // other session independent
  });
  it("reset clears a session's count", () => {
    const b = createLlmBudget({ maxCallsPerSession: 1 });
    expect(b.tryConsume("s1")).toBe(true);
    expect(b.tryConsume("s1")).toBe(false);
    b.reset("s1");
    expect(b.tryConsume("s1")).toBe(true);
  });
});
