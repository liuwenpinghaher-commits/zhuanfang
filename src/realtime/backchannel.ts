import type { ExpressionState } from "../domain/types";

/**
 * Picks a short backchannel utterance for the cascade. Zero-latency (no LLM):
 * rotates a small per-state pool so it doesn't repeat, and—when the LLM-generated
 * pre_signals carry a depth guidance string (the same field the S2S engine uses
 * for circling/hesitating)—prefers that contextual nudge.
 */
const POOLS: Partial<Record<ExpressionState, string[]>> = {
  circling: ["所以核心是……", "你是说……", "让我确认一下，", "听起来重点在……"],
  emotional: ["嗯，我在听。", "慢慢说。", "我理解。", "别急。"],
  hesitating: ["嗯。", "然后呢？", "你接着说。"],
};
const DEFAULT_POOL = ["嗯。", "嗯嗯。", "然后呢？"];

export function createBackchannelPicker() {
  const counters = new Map<ExpressionState, number>();
  return function pick(expressionState: ExpressionState, depthGuidance?: string): string {
    if (
      (expressionState === "circling" || expressionState === "hesitating") &&
      depthGuidance &&
      depthGuidance.trim()
    ) {
      return depthGuidance.trim();
    }
    const pool = POOLS[expressionState] ?? DEFAULT_POOL;
    const n = counters.get(expressionState) ?? 0;
    counters.set(expressionState, n + 1);
    return pool[n % pool.length];
  };
}
