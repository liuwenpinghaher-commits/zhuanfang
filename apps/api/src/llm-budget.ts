export interface LlmBudget {
  tryConsume(sessionId: string): boolean;
  reset(sessionId: string): void;
}

export function createLlmBudget(opts?: { maxCallsPerSession?: number }): LlmBudget {
  const raw = opts?.maxCallsPerSession ?? Number(process.env.LLM_MAX_CALLS_PER_SESSION);
  const max = Number.isFinite(raw) && raw > 0 ? raw : 200;
  const counts = new Map<string, number>();

  return {
    tryConsume(sessionId: string): boolean {
      const current = counts.get(sessionId) ?? 0;
      if (current < max) {
        counts.set(sessionId, current + 1);
        return true;
      }
      return false;
    },
    reset(sessionId: string): void {
      counts.delete(sessionId);
    }
  };
}
