/**
 * In-process Stage-2 metrics: voice latency samples + recall outcomes.
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

const MAX_VOICE = 64;
const MAX_RECALL = 128;

const voiceSamples: VoiceLatencySample[] = [];
const recallEvents: RecallMetricEvent[] = [];

export function recordVoiceLatency(sample: Omit<VoiceLatencySample, "at"> & { at?: string }) {
  voiceSamples.push({ at: sample.at ?? new Date().toISOString(), ...sample });
  while (voiceSamples.length > MAX_VOICE) voiceSamples.shift();
}

export function recordRecallEvent(event: Omit<RecallMetricEvent, "at"> & { at?: string }) {
  recallEvents.push({ at: event.at ?? new Date().toISOString(), ...event });
  while (recallEvents.length > MAX_RECALL) recallEvents.shift();
}

function percentile(sorted: number[], p: number): number | undefined {
  if (!sorted.length) return undefined;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export function summarizeVoiceLatency(samples: VoiceLatencySample[] = voiceSamples) {
  const ttfa = samples.map((s) => s.ttfaMs).filter((n): n is number => typeof n === "number" && Number.isFinite(n));
  const sorted = [...ttfa].sort((a, b) => a - b);
  const interruptCount = samples.filter((s) => s.interrupted).length;
  return {
    sampleCount: samples.length,
    ttfaCount: sorted.length,
    ttfaP50Ms: percentile(sorted, 50),
    ttfaP95Ms: percentile(sorted, 95),
    interruptCount,
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

export function getRuntimeMetricsSnapshot() {
  return {
    generatedAt: new Date().toISOString(),
    voice: summarizeVoiceLatency(),
    recall: summarizeRecall()
  };
}

/** Test helper — clear buffers between cases. */
export function resetRuntimeMetricsForTests() {
  voiceSamples.length = 0;
  recallEvents.length = 0;
}
