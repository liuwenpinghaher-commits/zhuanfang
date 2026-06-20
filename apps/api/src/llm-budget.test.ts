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

  // P1-17: the shared "system" bucket never gets an explicit reset (only session keys do),
  // so without a sliding window it would stall forever once it hits the cap.
  it("rolls over the system bucket after its sliding window elapses", async () => {
    const b = createLlmBudget({ maxCallsPerSession: 1, systemWindowMs: 20 });
    expect(b.tryConsume("system")).toBe(true);
    expect(b.tryConsume("system")).toBe(false); // cap hit within the window
    await new Promise((r) => setTimeout(r, 30)); // let the window elapse
    expect(b.tryConsume("system")).toBe(true);   // window rolled over — not permanently stuck
  });

  it("does NOT auto-roll a per-session key (only system buckets get the window)", async () => {
    const b = createLlmBudget({ maxCallsPerSession: 1, systemWindowMs: 5 });
    expect(b.tryConsume("session-abc")).toBe(true);
    expect(b.tryConsume("session-abc")).toBe(false);
    await new Promise((r) => setTimeout(r, 15));
    // session keys are bounded by an explicit reset at /end, NOT the time window
    expect(b.tryConsume("session-abc")).toBe(false);
  });
});
