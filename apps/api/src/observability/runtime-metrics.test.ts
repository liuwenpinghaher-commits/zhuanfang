import { describe, expect, it, beforeEach } from "vitest";
import {
  getRuntimeMetricsSnapshot,
  recordRecallEvent,
  recordReindexEvent,
  recordVoiceLatency,
  resetRuntimeMetricsForTests,
  resolveMetricsJsonlPath,
  summarizeReindex,
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
    expect(s.ttfaCount).toBe(6);
    expect(s.ttfaP50Ms).toBeDefined();
    expect(s.ttfaP95Ms).toBeDefined();
    expect(s.interruptCount).toBe(1);
    expect(s.bargeInSuccessCount).toBe(1);
    expect(s.interruptRecoveryCount).toBe(1);
    expect(s.segments.llmTtft.count).toBe(5);
    expect(s.budgetHint.ttfaP95TargetMs).toBe(1200);
  });

  it("accepts bargeInSuccess false and interruptRecovery aggregates", () => {
    recordVoiceLatency({
      path: "cascade",
      interrupted: true,
      bargeInSuccess: false,
      interruptRecovery: false
    });
    recordVoiceLatency({
      path: "cascade",
      interrupted: true,
      bargeInSuccess: true,
      interruptRecovery: true
    });
    const s = summarizeVoiceLatency();
    expect(s.bargeInSuccessCount).toBe(1);
    expect(s.bargeInFailCount).toBe(1);
    expect(s.bargeInSuccessRate).toBeCloseTo(0.5);
    expect(s.interruptRecoveryCount).toBe(1);
    expect(s.interruptRecoveryRate).toBeCloseTo(0.5);
  });

  it("counts falseTrigger quarantine and max_wait_suppressed events", () => {
    recordVoiceLatency({ path: "cascade", falseTriggerKind: "quarantine_echo_suspect" });
    recordVoiceLatency({ path: "cascade", falseTriggerKind: "quarantine_echo_suspect" });
    recordVoiceLatency({ path: "cascade", falseTriggerKind: "max_wait_suppressed" });
    const s = summarizeVoiceLatency();
    expect(s.falseTriggerCount).toBe(3);
    expect(s.falseTriggerByKind.quarantine_echo_suspect).toBe(2);
    expect(s.falseTriggerByKind.max_wait_suppressed).toBe(1);
    expect(s.falseTriggerByKind.auto_committed_echo_suspect).toBe(0);
    const snap = getRuntimeMetricsSnapshot();
    expect(snap.voice.falseTriggerCount).toBe(3);
  });

  it("event-only falseTrigger samples do not create TTFA percentiles", () => {
    recordVoiceLatency({ path: "cascade", falseTriggerKind: "quarantine_echo_suspect" });
    recordVoiceLatency({ path: "cascade", falseTriggerKind: "max_wait_suppressed" });
    const s = summarizeVoiceLatency();
    expect(s.falseTriggerCount).toBe(2);
    expect(s.sampleCount).toBe(2);
    expect(s.ttfaCount).toBe(0);
    expect(s.ttfaP50Ms).toBeUndefined();
    expect(s.ttfaP95Ms).toBeUndefined();
    expect(s.segments.llmTtft.count).toBe(0);
  });

  it("falseTrigger flood does not shift existing TTFA percentiles (separate rings)", () => {
    for (const ms of [100, 200, 300, 400, 500]) {
      recordVoiceLatency({ path: "cascade", ttfaMs: ms, vadEndToSttMs: 40 });
    }
    const before = summarizeVoiceLatency();
    expect(before.ttfaCount).toBe(5);
    for (let i = 0; i < 80; i++) {
      recordVoiceLatency({ path: "cascade", falseTriggerKind: "max_wait_suppressed" });
    }
    const after = summarizeVoiceLatency();
    expect(after.ttfaCount).toBe(before.ttfaCount);
    expect(after.ttfaP50Ms).toBe(before.ttfaP50Ms);
    expect(after.ttfaP95Ms).toBe(before.ttfaP95Ms);
    expect(after.falseTriggerCount).toBe(64); // event ring capped at MAX_VOICE_EVENTS
    expect(after.sampleCount).toBe(5 + 64);
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

  it("tracks reindex success/fail counters and snapshot.reindex", () => {
    recordReindexEvent({
      outcome: "success",
      changedSources: 2,
      chunkCount: 3,
      embeddedCount: 2,
      durationMs: 40
    });
    recordReindexEvent({ outcome: "failed", error: "boom", durationMs: 5 });
    recordReindexEvent({ outcome: "stale_discarded", chunkCount: 1, durationMs: 10 });
    const s = summarizeReindex();
    expect(s.successTotal).toBe(1);
    expect(s.failedTotal).toBe(1);
    expect(s.staleDiscardedTotal).toBe(1);
    expect(s.eventCount).toBe(3);
    expect(s.lastOutcome).toBe("stale_discarded");
    const snap = getRuntimeMetricsSnapshot();
    expect(snap.reindex.failedTotal).toBe(1);
    expect(snap.reindex.successTotal).toBe(1);
  });

  it("records ttsPcmTtfbMs without redefining ttsTtfbMs", () => {
    recordVoiceLatency({ path: "cascade", ttsTtfbMs: 60, ttsPcmTtfbMs: 180 });
    recordVoiceLatency({ path: "cascade", ttsTtfbMs: 80, ttsPcmTtfbMs: 220 });
    const s = summarizeVoiceLatency();
    expect(s.ttsTtfbDefinition).toBe("pcm_scheduled");
    expect(s.segments.ttsTtfb.count).toBe(2);
    expect(s.segments.ttsTtfb.p50Ms).toBe(60);
    expect(s.segments.ttsPcmTtfb.count).toBe(2);
    expect(s.segments.ttsPcmTtfb.p50Ms).toBe(180);
    expect(s.segments.ttsTtfb.p50Ms).not.toBe(s.segments.ttsPcmTtfb.p50Ms);
  });

  it("openingAudible and playbackContextState are summarized separately from barge success", () => {
    recordVoiceLatency({
      path: "cascade",
      openingAudible: true,
      playbackContextState: "running",
      ttsPcmTtfbMs: 140
    });
    recordVoiceLatency({
      path: "cascade",
      openingAudible: false,
      playbackContextState: "suspended"
    });
    recordVoiceLatency({
      path: "cascade",
      falseTriggerKind: "opening_second_turn_abort",
      bargeInSuccess: false,
      takeFloor: false,
      openingAudible: false
    });
    recordVoiceLatency({
      path: "cascade",
      interrupted: true,
      bargeInSuccess: true,
      takeFloor: true
    });
    const s = summarizeVoiceLatency();
    expect(s.openingAudibleCount).toBe(1);
    expect(s.openingInaudibleCount).toBe(2);
    expect(s.playbackContextState).toBe("suspended");
    expect(s.takeFloorCount).toBe(1);
    expect(s.bargeInSuccessCount).toBe(1);
    expect(s.bargeInFailCount).toBe(1);
    expect(s.falseTriggerByKind.opening_second_turn_abort).toBe(1);
    expect(s.interruptCount).toBe(1);
  });

  it("resolveMetricsJsonlPath prefers PRODUCT_METRICS_JSONL_PATH then PERSIST_PATH alias", () => {
    expect(resolveMetricsJsonlPath({})).toBeUndefined();
    expect(resolveMetricsJsonlPath({ PRODUCT_METRICS_JSONL_PATH: " /tmp/m.jsonl " })).toBe("/tmp/m.jsonl");
    expect(resolveMetricsJsonlPath({ PRODUCT_METRICS_PERSIST_PATH: "/tmp/p.jsonl" })).toBe("/tmp/p.jsonl");
    expect(
      resolveMetricsJsonlPath({
        PRODUCT_METRICS_JSONL_PATH: "/tmp/a.jsonl",
        PRODUCT_METRICS_PERSIST_PATH: "/tmp/b.jsonl"
      })
    ).toBe("/tmp/a.jsonl");
  });
});
