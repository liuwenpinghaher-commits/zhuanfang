import type { ExpressionState } from "../domain/types";
import type { Completeness } from "./turnCompleteness";

export interface CascadeTurnInput {
  expressionState: ExpressionState;
  silenceMs: number;
  completeness: Completeness;
  maxWaitMs?: number;   // safety net only; default 8000
  minPauseMs?: number;  // below this, always wait; default 600
}
export interface CascadeTurnDecision {
  action: "respond" | "wait" | "backchannel" | "uncertain";
  reason: string;
}

/**
 * Layer 0+1 turn decision (pure, synchronous). Timing only — preSignals is a
 * CONTENT signal and is consumed by the backchannel picker + response prompt,
 * not here. "uncertain" escalates to the Layer 2 LLM endpoint.
 */
export function decideCascadeTurn(input: CascadeTurnInput): CascadeTurnDecision {
  const maxWait = input.maxWaitMs ?? 8000;
  const minPause = input.minPauseMs ?? 600;

  if (input.silenceMs >= maxWait) return { action: "respond", reason: "max-wait safety net" };
  if (input.silenceMs < minPause) return { action: "wait", reason: "pause too short" };

  // Affective states get an instant backchannel (rapport, no LLM).
  if (input.expressionState === "emotional") return { action: "backchannel", reason: "emotional → empathy" };
  if (input.expressionState === "circling") return { action: "backchannel", reason: "circling → nudge summary" };

  switch (input.completeness) {
    case "complete":   return { action: "respond", reason: "transcript reads complete" };
    case "incomplete": return { action: "wait", reason: "transcript reads incomplete (hanging)" };
    case "ambiguous":  return { action: "uncertain", reason: "ambiguous → LLM endpoint" };
  }
}


/** False-barge-in suppression: ignore ultra-short VAD blips while AI is speaking. */
export function shouldAcceptBargeIn(speechMs: number, minBargeInMs = 280): boolean {
  return speechMs >= minBargeInMs;
}
