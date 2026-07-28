/**
 * Stage-3 experimental "pVAD-lite" endpointing (no neural pVAD weights).
 * Uses expression energy + silence + semantic completeness to bias minPause.
 * Honest: not a production pVAD model — capability remains experimental.
 */
import type { ExpressionState } from "../domain/types";
import type { Completeness } from "./turnCompleteness";

export type EndpointingMode = "silence" | "semantic" | "pvad-experimental";

export interface PvadEndpointingInput {
  mode: EndpointingMode;
  expressionState: ExpressionState;
  silenceMs: number;
  completeness: Completeness;
  /** Peak |sample| energy 0..1 from last speech window (optional). */
  recentEnergy?: number;
  baseMinPauseMs?: number;
  baseMaxWaitMs?: number;
}

export interface PvadEndpointingTuning {
  minPauseMs: number;
  maxWaitMs: number;
  /** When true, prefer respond over uncertain for mild ambiguity. */
  preferRespondOnAmbiguous: boolean;
  label: string;
}

/**
 * Derive timing knobs for cascade turn decision under the selected endpointing mode.
 */
export function resolveEndpointingTuning(input: PvadEndpointingInput): PvadEndpointingTuning {
  const baseMin = input.baseMinPauseMs ?? 600;
  const baseMax = input.baseMaxWaitMs ?? 8000;

  if (input.mode === "silence") {
    return {
      minPauseMs: baseMin,
      maxWaitMs: baseMax,
      preferRespondOnAmbiguous: false,
      label: "silence"
    };
  }

  if (input.mode === "semantic") {
    return {
      minPauseMs: baseMin,
      maxWaitMs: baseMax,
      preferRespondOnAmbiguous: input.completeness === "complete",
      label: "semantic"
    };
  }

  // pvad-experimental: energy + expression bias
  const energy = typeof input.recentEnergy === "number" ? input.recentEnergy : 0.2;
  let minPauseMs = baseMin;
  let maxWaitMs = baseMax;
  let preferRespondOnAmbiguous = false;

  if (input.expressionState === "concluding" || input.completeness === "complete") {
    minPauseMs = Math.max(280, Math.round(baseMin * 0.55));
    preferRespondOnAmbiguous = true;
  } else if (input.expressionState === "circling" || input.completeness === "incomplete") {
    minPauseMs = Math.round(baseMin * 1.35);
    maxWaitMs = Math.round(baseMax * 1.1);
  } else if (energy < 0.08 && input.silenceMs >= baseMin) {
    // low residual energy after pause → likely end-of-turn
    minPauseMs = Math.max(320, Math.round(baseMin * 0.7));
    preferRespondOnAmbiguous = true;
  } else if (energy > 0.35) {
    // still hot energy → wait a bit more
    minPauseMs = Math.round(baseMin * 1.15);
  }

  return {
    minPauseMs,
    maxWaitMs,
    preferRespondOnAmbiguous,
    label: "pvad-experimental"
  };
}

/**
 * Optional post-decision nudge: when pVAD-lite prefers respond on ambiguous, escalate wait→uncertain→respond path.
 * Pure helper for tests; pipeline may call after decideCascadeTurn.
 */
export function applyPvadDecisionBias(
  action: "respond" | "wait" | "backchannel" | "uncertain",
  tuning: PvadEndpointingTuning
): "respond" | "wait" | "backchannel" | "uncertain" {
  if (!tuning.preferRespondOnAmbiguous) return action;
  if (action === "uncertain") return "respond";
  return action;
}
