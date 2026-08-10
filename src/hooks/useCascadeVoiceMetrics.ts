import { useCallback } from "react";
import { productApiClient } from "../api/productApi";

/** Cascade → Product API voice latency / barge-in / false-trigger sample. */
export type CascadeVoiceMetricSample = {
  ttfaMs?: number;
  vadEndToSttMs?: number;
  sttToLlmMs?: number;
  llmTtftMs?: number;
  ttsTtfbMs?: number;
  interrupted?: boolean;
  bargeInSuccess?: boolean;
  interruptRecovery?: boolean;
  falseTriggerKind?: "quarantine_echo_suspect" | "max_wait_suppressed" | "auto_committed_echo_suspect";
};

/**
 * Stage-2/3: report cascade TTFA, barge-in, and false-trigger samples to Product API (best-effort).
 * Keeps App shell free of telemetry plumbing details.
 */
export function useCascadeVoiceMetrics(sessionId?: string | null) {
  const reportLatency = useCallback(
    (sample: CascadeVoiceMetricSample) => {
      void productApiClient.reportVoiceLatency({
        path: "cascade",
        ...sample,
        ...(sessionId ? { sessionId } : {})
      });
    },
    [sessionId]
  );

  return { reportLatency };
}
