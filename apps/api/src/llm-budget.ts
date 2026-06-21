export interface LlmBudget {
  tryConsume(sessionId: string): boolean;
  reset(sessionId: string): void;
}

// P1-17: keys that are NOT per-session — the shared "system" bucket plus the background
// research bucket. These never get a budget.reset() (only session keys do, at /end), so
// without a sliding window they'd accumulate to the cap once and then silently block ALL
// non-session LLM enrichment forever. A time-windowed reset lets them recover.
//
// NOTE: this is still a CALL COUNTER, not a token meter. The window bounds calls-per-window
// for system buckets; it does not measure token spend. Per-session keys keep the simple
// monotonic counter (reset explicitly when the session ends).
const SYSTEM_BUDGET_KEYS = new Set(["system", "research_auto_run"]);

// Default sliding window for system buckets (1 hour). Override via LLM_SYSTEM_WINDOW_MS or
// the opts param (tests). The cap (maxCallsPerSession) is reused as the per-window cap.
const DEFAULT_SYSTEM_WINDOW_MS = 60 * 60 * 1000;

export function createLlmBudget(opts?: { maxCallsPerSession?: number; systemWindowMs?: number }): LlmBudget {
  const raw = opts?.maxCallsPerSession ?? Number(process.env.LLM_MAX_CALLS_PER_SESSION);
  // An explicit, finite cap >= 0 is honored verbatim — including 0, which is a deliberate
  // kill-switch that blocks every call. Only an absent/NaN/negative (invalid) config falls
  // back to the default 200. Collapsing 0 into "unset" would silently allow 200 calls when
  // the operator asked for zero.
  const max = Number.isFinite(raw) && raw >= 0 ? raw : 200;

  const rawWindow = opts?.systemWindowMs ?? Number(process.env.LLM_SYSTEM_WINDOW_MS);
  const systemWindowMs = Number.isFinite(rawWindow) && rawWindow > 0 ? rawWindow : DEFAULT_SYSTEM_WINDOW_MS;

  const counts = new Map<string, number>();
  // Window start per system key — when now - start >= window, the counter rolls over.
  const windowStart = new Map<string, number>();

  return {
    tryConsume(sessionId: string): boolean {
      // Sliding-window rollover for system buckets so they can't permanently stall.
      if (SYSTEM_BUDGET_KEYS.has(sessionId)) {
        const now = Date.now();
        const start = windowStart.get(sessionId);
        if (start === undefined || now - start >= systemWindowMs) {
          windowStart.set(sessionId, now);
          counts.set(sessionId, 0);
        }
      }

      const current = counts.get(sessionId) ?? 0;
      if (current < max) {
        counts.set(sessionId, current + 1);
        return true;
      }
      return false;
    },
    reset(sessionId: string): void {
      counts.delete(sessionId);
      windowStart.delete(sessionId);
    }
  };
}
