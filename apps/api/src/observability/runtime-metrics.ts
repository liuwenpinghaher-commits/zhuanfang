/**
 * In-process Stage-2/3 metrics: voice latency, barge-in, recall, grounding, reindex.
 * Single-user local tool — process memory is enough; no external TSDB required.
 *
 * Buffer layout (Phase-0):
 * - `voiceSamples` — latency / barge-in / interrupt samples (TTFA window).
 * - `voiceEventSamples` — false-trigger-only events (do NOT compete for TTFA slots).
 * Prefer `ttfaCount` over `sampleCount` when reading latency window size:
 * `sampleCount` = latency ring + event ring totals.
 *
 * Optional disk: PRODUCT_METRICS_JSONL_PATH (or PRODUCT_METRICS_PERSIST_PATH) appends
 * `getRuntimeMetricsSnapshot()` lines. **Does not change** recordVoiceLatency / POST body schema.
 */

import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/** Phase-0 false-trigger countable kinds (echo / max-wait suppress / opening abort). */
export type FalseTriggerKind =
  | "quarantine_echo_suspect"
  | "max_wait_suppressed"
  | "auto_committed_echo_suspect"
  | "opening_second_turn_abort";

export const FALSE_TRIGGER_KINDS: readonly FalseTriggerKind[] = [
  "quarantine_echo_suspect",
  "max_wait_suppressed",
  "auto_committed_echo_suspect",
  "opening_second_turn_abort"
] as const;

export type PlaybackContextState = "running" | "suspended";
/** Snapshot tag for the PCM ring — never silently rewrite ttsTtfbMs. */
export const TTS_TTFB_DEFINITION = "pcm_scheduled" as const;
export type TtsTtfbDefinition = typeof TTS_TTFB_DEFINITION;

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
  /** Call-time of speak(); legacy diagnostic — do not swap to first PCM. */
  ttsTtfbMs?: number;
  /** First PCM buffer scheduled into AudioContext. */
  ttsPcmTtfbMs?: number;
  openingAudible?: boolean;
  playbackContextState?: PlaybackContextState;
  interrupted?: boolean;
  /** Stage-3: interrupt stopped playback / cancelled turn successfully. */
  bargeInSuccess?: boolean;
  /** Successful barge that took the floor; opening second-turn abort is not this. */
  takeFloor?: boolean;
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

/** Knowledge reindex outcome (write path stays fire-and-forget; this is observability only). */
export type ReindexOutcome = "success" | "failed" | "stale_discarded" | "noop";

export interface ReindexMetricEvent {
  at: string;
  outcome: ReindexOutcome;
  removedSources?: number;
  changedSources?: number;
  materialRemoved?: number;
  transcriptSessionsRemoved?: number;
  chunkCount?: number;
  embeddedCount?: number;
  durationMs?: number;
  error?: string;
  /** Optional multi-user key (may be redacted by caller). */
  userKey?: string;
}

const MAX_VOICE = 64;
const MAX_VOICE_EVENTS = 64;
const MAX_RECALL = 128;
const MAX_GROUNDING = 128;
const MAX_REINDEX = 64;

/** Latency / barge-in samples — TTFA percentiles read only from this ring. */
const voiceSamples: VoiceLatencySample[] = [];
/** False-trigger-only events — separate ring so dense events cannot evict TTFA points. */
const voiceEventSamples: VoiceLatencySample[] = [];
const recallEvents: RecallMetricEvent[] = [];
const groundingEvents: GroundingMetricEvent[] = [];
const reindexEvents: ReindexMetricEvent[] = [];

/** Process-lifetime counters (survive ring eviction). */
const reindexTotals = {
  success: 0,
  failed: 0,
  stale_discarded: 0,
  noop: 0
};

function hasLatencyFields(sample: Omit<VoiceLatencySample, "at">): boolean {
  return (
    typeof sample.ttfaMs === "number" ||
    typeof sample.vadEndToSttMs === "number" ||
    typeof sample.sttToLlmMs === "number" ||
    typeof sample.llmTtftMs === "number" ||
    typeof sample.ttsTtfbMs === "number" ||
    typeof sample.ttsPcmTtfbMs === "number"
  );
}

function isBargeOrInterruptSample(sample: Omit<VoiceLatencySample, "at">): boolean {
  return (
    sample.interrupted === true ||
    sample.bargeInSuccess !== undefined ||
    sample.interruptRecovery !== undefined ||
    sample.takeFloor !== undefined ||
    sample.openingAudible !== undefined ||
    sample.playbackContextState !== undefined
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

  // Optional JSONL: throttle on sample path (do not block hot path).
  maybePersistMetricsJsonl("sample");
}

export function recordRecallEvent(event: Omit<RecallMetricEvent, "at"> & { at?: string }) {
  recallEvents.push({ at: event.at ?? new Date().toISOString(), ...event });
  while (recallEvents.length > MAX_RECALL) recallEvents.shift();
}

export function recordGroundingEvent(event: Omit<GroundingMetricEvent, "at"> & { at?: string }) {
  groundingEvents.push({ at: event.at ?? new Date().toISOString(), ...event });
  while (groundingEvents.length > MAX_GROUNDING) groundingEvents.shift();
}

export function recordReindexEvent(event: Omit<ReindexMetricEvent, "at"> & { at?: string }) {
  const full: ReindexMetricEvent = { at: event.at ?? new Date().toISOString(), ...event };
  reindexEvents.push(full);
  while (reindexEvents.length > MAX_REINDEX) reindexEvents.shift();
  if (full.outcome in reindexTotals) {
    reindexTotals[full.outcome] += 1;
  }
  // Reindex is rare; always try JSONL (still non-blocking).
  maybePersistMetricsJsonl("reindex");
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
  const openingAudibleCount = samples.filter((s) => s.openingAudible === true).length;
  const openingInaudibleCount = samples.filter((s) => s.openingAudible === false).length;
  const takeFloorCount = samples.filter((s) => s.takeFloor === true).length;
  let playbackContextState: PlaybackContextState | undefined;
  for (let i = samples.length - 1; i >= 0; i--) {
    if (samples[i].playbackContextState) {
      playbackContextState = samples[i].playbackContextState;
      break;
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
    takeFloorCount,
    openingAudibleCount,
    openingInaudibleCount,
    playbackContextState,
    /** New ring is first PCM scheduled; ttsTtfbMs stays call-time. */
    ttsTtfbDefinition: TTS_TTFB_DEFINITION,
    /** Phase-0: countable false-trigger / echo-guard events. */
    falseTriggerCount,
    falseTriggerByKind,
    segments: {
      vadEndToStt: segmentPercentiles(samples, "vadEndToSttMs"),
      sttToLlm: segmentPercentiles(samples, "sttToLlmMs"),
      llmTtft: segmentPercentiles(samples, "llmTtftMs"),
      ttsTtfb: segmentPercentiles(samples, "ttsTtfbMs"),
      ttsPcmTtfb: segmentPercentiles(samples, "ttsPcmTtfbMs")
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

export function summarizeReindex(events: ReindexMetricEvent[] = reindexEvents) {
  const last = events.length > 0 ? events[events.length - 1] : undefined;
  return {
    eventCount: events.length,
    successTotal: reindexTotals.success,
    failedTotal: reindexTotals.failed,
    staleDiscardedTotal: reindexTotals.stale_discarded,
    noopTotal: reindexTotals.noop,
    lastAt: last?.at,
    lastOutcome: last?.outcome,
    lastDurationMs: last?.durationMs,
    recent: events.slice(-8)
  };
}

export function getRuntimeMetricsSnapshot() {
  return {
    generatedAt: new Date().toISOString(),
    voice: summarizeVoiceLatency(),
    recall: summarizeRecall(),
    grounding: summarizeGrounding(),
    reindex: summarizeReindex()
  };
}

// --- Optional JSONL persist (PR-O4) ---

const DEFAULT_JSONL_MIN_GAP_MS = 30_000;
const DEFAULT_JSONL_INTERVAL_MS = 60_000;

let lastJsonlWriteAt = 0;
let jsonlInterval: ReturnType<typeof setInterval> | undefined;
let jsonlStartedForPath: string | undefined;

/**
 * Resolve optional JSONL path. Primary: PRODUCT_METRICS_JSONL_PATH.
 * Alias: PRODUCT_METRICS_PERSIST_PATH (SIC+ design). Empty = disabled.
 */
export function resolveMetricsJsonlPath(
  env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}
): string | undefined {
  const primary = (env.PRODUCT_METRICS_JSONL_PATH ?? "").trim();
  const alias = (env.PRODUCT_METRICS_PERSIST_PATH ?? "").trim();
  const path = primary || alias;
  return path || undefined;
}

export async function appendRuntimeMetricsJsonl(
  snapshot: ReturnType<typeof getRuntimeMetricsSnapshot> = getRuntimeMetricsSnapshot(),
  env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}
): Promise<boolean> {
  const path = resolveMetricsJsonlPath(env);
  if (!path) return false;
  try {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(snapshot)}\n`, "utf8");
    lastJsonlWriteAt = Date.now();
    return true;
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "metrics_jsonl_append_failed",
        path,
        error: err instanceof Error ? err.message : String(err)
      })
    );
    return false;
  }
}

/**
 * Fire-and-forget JSONL append with throttle for high-frequency sample path.
 * reason "reindex" / "interval" bypasses the min-gap (reindex is rare; interval is paced).
 */
export function maybePersistMetricsJsonl(
  reason: "sample" | "reindex" | "interval" | "manual" = "sample",
  env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}
): void {
  const path = resolveMetricsJsonlPath(env);
  if (!path) return;
  ensureMetricsJsonlAutoPersist(env);
  const minGap = Math.max(
    5_000,
    Number(env.PRODUCT_METRICS_JSONL_MIN_GAP_MS) || DEFAULT_JSONL_MIN_GAP_MS
  );
  const now = Date.now();
  if (reason === "sample" && now - lastJsonlWriteAt < minGap) return;
  void appendRuntimeMetricsJsonl(getRuntimeMetricsSnapshot(), env);
}

/**
 * Start periodic snapshot append when path is configured. Idempotent; interval is unref'd
 * so it does not alone keep the process alive. Safe no-op when path empty.
 */
export function ensureMetricsJsonlAutoPersist(
  env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}
): void {
  const path = resolveMetricsJsonlPath(env);
  if (!path) return;
  if (jsonlInterval && jsonlStartedForPath === path) return;
  if (jsonlInterval) {
    clearInterval(jsonlInterval);
    jsonlInterval = undefined;
  }
  const intervalMs = Math.max(
    10_000,
    Number(env.PRODUCT_METRICS_JSONL_INTERVAL_MS) || DEFAULT_JSONL_INTERVAL_MS
  );
  jsonlStartedForPath = path;
  jsonlInterval = setInterval(() => {
    maybePersistMetricsJsonl("interval", env);
  }, intervalMs);
  if (typeof jsonlInterval.unref === "function") jsonlInterval.unref();
}

/** Test helper — clear buffers between cases. */
export function resetRuntimeMetricsForTests() {
  voiceSamples.length = 0;
  voiceEventSamples.length = 0;
  recallEvents.length = 0;
  groundingEvents.length = 0;
  reindexEvents.length = 0;
  reindexTotals.success = 0;
  reindexTotals.failed = 0;
  reindexTotals.stale_discarded = 0;
  reindexTotals.noop = 0;
  lastJsonlWriteAt = 0;
  if (jsonlInterval) {
    clearInterval(jsonlInterval);
    jsonlInterval = undefined;
  }
  jsonlStartedForPath = undefined;
}
