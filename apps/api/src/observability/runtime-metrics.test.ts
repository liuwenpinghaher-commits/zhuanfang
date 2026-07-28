import { describe, expect, it, beforeEach } from "vitest";
import {
  getRuntimeMetricsSnapshot,
  recordRecallEvent,
  recordVoiceLatency,
  resetRuntimeMetricsForTests,
  summarizeVoiceLatency
} from "./runtime-metrics";

describe("runtime-metrics", () => {
  beforeEach(() => resetRuntimeMetricsForTests());

  it("aggregates voice p50/p95 and interrupt count", () => {
    for (const ms of [100, 200, 300, 400, 1000]) {
      recordVoiceLatency({ path: "cascade", ttfaMs: ms, vadEndToSttMs: 40, llmTtftMs: 120 });
    }
    recordVoiceLatency({
      path: "interrupt",
      interrupted: true,
      bargeInSuccess: true,
      interruptRecovery: true,
      ttfaMs: 50
    });
    const s = summarizeVoiceLatency();
    expect(s.sampleCount).toBe(6);
    expect(s.ttfaP50Ms).toBeDefined();
    expect(s.ttfaP95Ms).toBeDefined();
    expect(s.interruptCount).toBe(1);
    expect(s.bargeInSuccessCount).toBe(1);
    expect(s.interruptRecoveryCount).toBe(1);
    expect(s.segments.llmTtft.count).toBe(5);
    expect(s.budgetHint.ttfaP95TargetMs).toBe(1200);
  });

  it("tracks recall empty vs hit", () => {
    recordRecallEvent({ capability: "chat", outcome: "empty" });
    recordRecallEvent({ capability: "chat", outcome: "hit", hitCount: 3, topScore: 0.4 });
    const snap = getRuntimeMetricsSnapshot();
    expect(snap.recall.empty).toBe(1);
    expect(snap.recall.hit).toBe(1);
  });

  it("tracks grounding modes", async () => {
    const { recordGroundingEvent } = await import("./runtime-metrics");
    recordGroundingEvent({ capability: "chat", mode: "grounded", citationCount: 2 });
    recordGroundingEvent({ capability: "chat", mode: "refused", citationCount: 0 });
    const snap = getRuntimeMetricsSnapshot();
    expect(snap.grounding.grounded).toBe(1);
    expect(snap.grounding.refused).toBe(1);
    expect(snap.grounding.citationPresentRate).toBe(0.5);
  });
});
