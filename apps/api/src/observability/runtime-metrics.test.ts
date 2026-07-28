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
      recordVoiceLatency({ path: "cascade", ttfaMs: ms });
    }
    recordVoiceLatency({ path: "interrupt", interrupted: true, ttfaMs: 50 });
    const s = summarizeVoiceLatency();
    expect(s.sampleCount).toBe(6);
    expect(s.ttfaP50Ms).toBeDefined();
    expect(s.ttfaP95Ms).toBeDefined();
    expect(s.interruptCount).toBe(1);
  });

  it("tracks recall empty vs hit", () => {
    recordRecallEvent({ capability: "chat", outcome: "empty" });
    recordRecallEvent({ capability: "chat", outcome: "hit", hitCount: 3, topScore: 0.4 });
    const snap = getRuntimeMetricsSnapshot();
    expect(snap.recall.empty).toBe(1);
    expect(snap.recall.hit).toBe(1);
  });
});
