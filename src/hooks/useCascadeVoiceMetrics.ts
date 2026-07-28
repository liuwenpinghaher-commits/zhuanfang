import { useCallback } from "react";
import { productApiClient } from "../api/productApi";

/**
 * Stage-2: report cascade TTFA samples to Product API (best-effort).
 * Keeps App shell free of telemetry plumbing details.
 */
export function useCascadeVoiceMetrics(sessionId?: string | null) {
  const reportLatency = useCallback(
    (sample: {
      ttfaMs: number;
      vadEndToSttMs?: number;
      sttToLlmMs?: number;
      llmTtftMs?: number;
      ttsTtfbMs?: number;
    }) => {
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
