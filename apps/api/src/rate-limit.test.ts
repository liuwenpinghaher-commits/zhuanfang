import { describe, expect, it } from "vitest";
import { createRateLimiter, rateLimitBucket } from "./rate-limit";

describe("createRateLimiter", () => {
  it("allows up to max within window then blocks", () => {
    let now = 1_000_000;
    const lim = createRateLimiter({ max: 3, windowMs: 60_000, now: () => now });
    expect(lim.take("a").allowed).toBe(true);
    expect(lim.take("a").allowed).toBe(true);
    expect(lim.take("a").allowed).toBe(true);
    const blocked = lim.take("a");
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
    // other keys independent
    expect(lim.take("b").allowed).toBe(true);
    // window rolls
    now += 60_001;
    expect(lim.take("a").allowed).toBe(true);
  });

  it("rateLimitBucket joins route and ip", () => {
    expect(rateLimitBucket("/api/chat", "1.2.3.4")).toBe("/api/chat|1.2.3.4");
  });
});
