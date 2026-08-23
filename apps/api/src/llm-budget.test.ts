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

  // An explicit cap of 0 means "block every LLM call" (a deliberate kill-switch), NOT
  // "unset → use the default". Distinguishing explicit 0 from an absent/NaN config is the
  // difference between a working kill-switch and silently allowing 200 calls per session.
  it("rejects every call when maxCallsPerSession is explicitly 0", () => {
    const b = createLlmBudget({ maxCallsPerSession: 0 });
    expect(b.tryConsume("s1")).toBe(false);
    expect(b.tryConsume("s1")).toBe(false);
    expect(b.tryConsume("another-session")).toBe(false);
    expect(b.tryConsume("system")).toBe(false);
  });

  it("falls back to the default cap when maxCallsPerSession is absent (NaN), not to reject-all", () => {
    const b = createLlmBudget({}); // unset → default 200, NOT 0
    expect(b.tryConsume("s1")).toBe(true);
  });

  it("counts an unknown sessionId from zero (first call allowed under a positive cap)", () => {
    const b = createLlmBudget({ maxCallsPerSession: 1 });
    expect(b.tryConsume("never-seen-before")).toBe(true);
    expect(b.tryConsume("never-seen-before")).toBe(false);
  });

  it("rolls over the reviews bucket after its sliding window elapses", async () => {
    const b = createLlmBudget({ maxCallsPerSession: 1, systemWindowMs: 20 });
    expect(b.tryConsume("reviews")).toBe(true);
    expect(b.tryConsume("reviews")).toBe(false);
    await new Promise((r) => setTimeout(r, 30));
    expect(b.tryConsume("reviews")).toBe(true);
  });
});
