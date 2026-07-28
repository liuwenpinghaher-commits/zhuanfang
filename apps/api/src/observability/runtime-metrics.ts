/**
 * In-process Stage-2/3 metrics: voice latency, barge-in, recall, grounding.
 * Single-user local tool — process memory is enough; no external TSDB required.
 */

export interface VoiceLatencySample {
  at: string;
  path: "cascade" | "omni" | "livekit" | "interrupt" | "unknown";
  /** End-of-user-speech → first assistant audio (ms), when known. */
  ttfaMs?: number;
  vadEndToSttMs?: number;
  sttToLlmMs?: number;
  llmTtftMs?: number;
  ttsTtfbMs?: number;
  interrupted?: boolean;
  /** Stage-3: interrupt stopped playback / cancelled turn successfully. */
  bargeInSuccess?: boolean;
  /** Stage-3: post-interrupt next turn retained interrupted context (stash). */
  interruptRecovery?: boolean;
  sessionId?: string;
}

export interface RecallMetricEvent {
  at: string;
  capability: "chat" | "interview" | "voice" | "rag";
  outcome: "hit" | "empty" | "low_score" | "error";
  topScore?: number;
  hitCount?: number;
  threshold?: number;
}

export type GroundingMode = "grounded" | "partial" | "refused";

export interface GroundingMetricEvent {
  at: string;
  capability: "chat" | "interview" | "rag";
  mode: GroundingMode;
  citationCount: number;
}

const MAX_VOICE = 64;
const MAX_RECALL = 128;
const MAX_GROUNDING = 128;

const voiceSamples: VoiceLatencySample[] = [];
const recallEvents: RecallMetricEvent[] = [];
const groundingEvents: GroundingMetricEvent[] = [];

export function recordVoiceLatency(sample: Omit<VoiceLatencySample, "at"> & { at?: string }) {
  voiceSamples.push({ at: sample.at ?? new Date().toISOString(), ...sample });
  while (voiceSamples.length > MAX_VOICE) voiceSamples.shift();
}

export function recordRecallEvent(event: Omit<RecallMetricEvent, "at"> & { at?: string }) {
  recallEvents.push({ at: event.at ?? new Date().toISOString(), ...event });
  while (recallEvents.length > MAX_RECALL) recallEvents.shift();
}

export function recordGroundingEvent(event: Omit<GroundingMetricEvent, "at"> & { at?: string }) {
  groundingEvents.push({ at: event.at ?? new Date().toISOString(), ...event });
  while (groundingEvents.length > MAX_GROUNDING) groundingEvents.shift();
}

function percentile(sorted: number[], p: number): number | undefined {
  if (!sorted.length) return undefined;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function segmentPercentiles(samples: VoiceLatencySample[], key: keyof VoiceLatencySample) {
  const vals = samples
    .map((s) => s[key])
    .filter((n): n is number => typeof n === "number" && Number.isFinite(n))
    .sort((a, b) => a - b);
  return {
    count: vals.length,
    p50Ms: percentile(vals, 50),
    p95Ms: percentile(vals, 95)
  };
}

export function summarizeVoiceLatency(samples: VoiceLatencySample[] = voiceSamples) {
  const ttfa = samples.map((s) => s.ttfaMs).filter((n): n is number => typeof n === "number" && Number.isFinite(n));
  const sorted = [...ttfa].sort((a, b) => a - b);
  const interruptSamples = samples.filter((s) => s.interrupted);
  const interruptCount = interruptSamples.length;
  const bargeInAttempts = samples.filter((s) => s.bargeInSuccess !== undefined || s.interrupted);
  const bargeInSuccessCount = samples.filter((s) => s.bargeInSuccess === true).length;
  const bargeInFailCount = samples.filter((s) => s.bargeInSuccess === false).length;
  const recoveryKnown = samples.filter((s) => s.interruptRecovery !== undefined);
  const interruptRecoveryCount = samples.filter((s) => s.interruptRecovery === true).length;
  return {
    sampleCount: samples.length,
    ttfaCount: sorted.length,
    ttfaP50Ms: percentile(sorted, 50),
    ttfaP95Ms: percentile(sorted, 95),
    interruptCount,
    bargeInSuccessCount,
    bargeInFailCount,
    bargeInSuccessRate:
      bargeInAttempts.length > 0 ? bargeInSuccessCount / Math.max(1, bargeInSuccessCount + bargeInFailCount) : undefined,
    interruptRecoveryCount,
    interruptRecoveryRate:
      recoveryKnown.length > 0 ? interruptRecoveryCount / recoveryKnown.length : undefined,
    segments: {
      vadEndToStt: segmentPercentiles(samples, "vadEndToSttMs"),
      sttToLlm: segmentPercentiles(samples, "sttToLlmMs"),
      llmTtft: segmentPercentiles(samples, "llmTtftMs"),
      ttsTtfb: segmentPercentiles(samples, "ttsTtfbMs")
    },
    /** Local cascade budget reference (not a hard SLA). */
    budgetHint: {
      ttfaP50TargetMs: 700,
      ttfaP95TargetMs: 1200,
      bargeInStopTargetMs: 200
    },
    recent: samples.slice(-8)
  };
}

export function summarizeRecall(events: RecallMetricEvent[] = recallEvents) {
  const counts = { hit: 0, empty: 0, low_score: 0, error: 0 };
  for (const e of events) {
    counts[e.outcome] += 1;
  }
  return {
    eventCount: events.length,
    ...counts,
    recent: events.slice(-12)
  };
}

export function summarizeGrounding(events: GroundingMetricEvent[] = groundingEvents) {
  const counts = { grounded: 0, partial: 0, refused: 0 };
  let citationPresent = 0;
  for (const e of events) {
    counts[e.mode] += 1;
    if (e.citationCount > 0) citationPresent += 1;
  }
  const n = events.length;
  return {
    eventCount: n,
    ...counts,
    groundedAnswerRate: n > 0 ? counts.grounded / n : undefined,
    refuseRate: n > 0 ? counts.refused / n : undefined,
    citationPresentRate: n > 0 ? citationPresent / n : undefined,
    recent: events.slice(-12)
  };
}

export function getRuntimeMetricsSnapshot() {
  return {
    generatedAt: new Date().toISOString(),
    voice: summarizeVoiceLatency(),
    recall: summarizeRecall(),
    grounding: summarizeGrounding()
  };
}

/** Test helper — clear buffers between cases. */
export function resetRuntimeMetricsForTests() {
  voiceSamples.length = 0;
  recallEvents.length = 0;
  groundingEvents.length = 0;
}
