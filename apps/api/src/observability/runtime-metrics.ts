/**
 * In-process Stage-2/3 metrics: voice latency, barge-in, recall, grounding.
 * Single-user local tool — process memory is enough; no external TSDB required.
 *
 * Buffer layout (Phase-0):
 * - `voiceSamples` — latency / barge-in / interrupt samples (TTFA window).
 * - `voiceEventSamples` — false-trigger-only events (do NOT compete for TTFA slots).
 * Prefer `ttfaCount` over `sampleCount` when reading latency window size:
 * `sampleCount` = latency ring + event ring totals.
 */

/** Phase-0 false-trigger countable kinds (echo / max-wait suppress). */
export type FalseTriggerKind =
  | "quarantine_echo_suspect"
  | "max_wait_suppressed"
  | "auto_committed_echo_suspect";

export const FALSE_TRIGGER_KINDS: readonly FalseTriggerKind[] = [
  "quarantine_echo_suspect",
  "max_wait_suppressed",
  "auto_committed_echo_suspect"
] as const;

export function isFalseTriggerKind(value: unknown): value is FalseTriggerKind {
  return (FALSE_TRIGGER_KINDS as readonly string[]).includes(value as string);
}

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
  /**
   * Phase-0: false-trigger / echo-guard event (countable).
   * May be sent alone (no ttfaMs) as a discrete event sample.
   */
  falseTriggerKind?: FalseTriggerKind;
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
const MAX_VOICE_EVENTS = 64;
const MAX_RECALL = 128;
const MAX_GROUNDING = 128;

/** Latency / barge-in samples — TTFA percentiles read only from this ring. */
const voiceSamples: VoiceLatencySample[] = [];
/** False-trigger-only events — separate ring so dense events cannot evict TTFA points. */
const voiceEventSamples: VoiceLatencySample[] = [];
const recallEvents: RecallMetricEvent[] = [];
const groundingEvents: GroundingMetricEvent[] = [];

function hasLatencyFields(sample: Omit<VoiceLatencySample, "at">): boolean {
  return (
    typeof sample.ttfaMs === "number" ||
    typeof sample.vadEndToSttMs === "number" ||
    typeof sample.sttToLlmMs === "number" ||
    typeof sample.llmTtftMs === "number" ||
    typeof sample.ttsTtfbMs === "number"
  );
}

function isBargeOrInterruptSample(sample: Omit<VoiceLatencySample, "at">): boolean {
  return (
    sample.interrupted === true ||
    sample.bargeInSuccess !== undefined ||
    sample.interruptRecovery !== undefined
  );
}

export function recordVoiceLatency(sample: Omit<VoiceLatencySample, "at"> & { at?: string }) {
  const full: VoiceLatencySample = { at: sample.at ?? new Date().toISOString(), ...sample };
  const latencyOrBarge = hasLatencyFields(full) || isBargeOrInterruptSample(full);

  if (latencyOrBarge) {
    voiceSamples.push(full);
    while (voiceSamples.length > MAX_VOICE) voiceSamples.shift();
  }

  // Event-only false-triggers use a separate ring (do not occupy TTFA slots).
  // If the same POST also carries latency/barge fields, it lives only in voiceSamples
  // and falseTrigger is counted from there during summarize.
  if (full.falseTriggerKind && isFalseTriggerKind(full.falseTriggerKind) && !latencyOrBarge) {
    voiceEventSamples.push(full);
    while (voiceEventSamples.length > MAX_VOICE_EVENTS) voiceEventSamples.shift();
  }
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

function emptyFalseTriggerByKind(): Record<FalseTriggerKind, number> {
  const counts = {} as Record<FalseTriggerKind, number>;
  for (const kind of FALSE_TRIGGER_KINDS) counts[kind] = 0;
  return counts;
}

/**
 * @param samples latency/barge ring (defaults to process buffer)
 * @param eventSamples false-trigger-only ring (defaults to process buffer)
 */
export function summarizeVoiceLatency(
  samples: VoiceLatencySample[] = voiceSamples,
  eventSamples: VoiceLatencySample[] = voiceEventSamples
) {
  const ttfa = samples.map((s) => s.ttfaMs).filter((n): n is number => typeof n === "number" && Number.isFinite(n));
  const sorted = [...ttfa].sort((a, b) => a - b);
  const interruptSamples = samples.filter((s) => s.interrupted);
  const interruptCount = interruptSamples.length;
  const bargeInAttempts = samples.filter((s) => s.bargeInSuccess !== undefined || s.interrupted);
  const bargeInSuccessCount = samples.filter((s) => s.bargeInSuccess === true).length;
  const bargeInFailCount = samples.filter((s) => s.bargeInSuccess === false).length;
  const recoveryKnown = samples.filter((s) => s.interruptRecovery !== undefined);
  const interruptRecoveryCount = samples.filter((s) => s.interruptRecovery === true).length;
  const falseTriggerByKind = emptyFalseTriggerByKind();
  let falseTriggerCount = 0;
  for (const s of [...samples, ...eventSamples]) {
    if (s.falseTriggerKind && isFalseTriggerKind(s.falseTriggerKind)) {
      falseTriggerByKind[s.falseTriggerKind] += 1;
      falseTriggerCount += 1;
    }
  }
  return {
    /** Total records in latency ring + event ring (not equal to ttfaCount). */
    sampleCount: samples.length + eventSamples.length,
    /** Finite TTFA points only — use this for latency window size / SLO. */
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
    /** Phase-0: countable false-trigger / echo-guard events. */
    falseTriggerCount,
    falseTriggerByKind,
    segments: {
      vadEndToStt: segmentPercentiles(samples, "vadEndToSttMs"),
      sttToLlm: segmentPercentiles(samples, "sttToLlmMs"),
      llmTtft: segmentPercentiles(samples, "llmTtftMs"),
      ttsTtfb: segmentPercentiles(samples, "ttsTtfbMs")
    },
    /**
     * Local cascade budget reference (not a hard SLA).
     * sampleCount includes event-only samples; latency percentiles use ttfaCount only.
     */
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
  voiceEventSamples.length = 0;
  recallEvents.length = 0;
  groundingEvents.length = 0;
}
