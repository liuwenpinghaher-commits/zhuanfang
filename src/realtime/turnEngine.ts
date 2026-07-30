/**
 * TurnEngine: single decision surface for cascade endpointing.
 * Composes completeness + pVAD-lite + cascadeTurnDecision without neural weights.
 */
import type { ExpressionState } from "../domain/types";
import { decideCascadeTurn } from "./cascadeTurnDecision";
import { applyPvadDecisionBias, resolveEndpointingTuning, type EndpointingMode } from "./pvadEndpointing";
import type { Completeness } from "./turnCompleteness";

export type TurnEngineAction = "respond" | "wait" | "backchannel" | "uncertain";

export interface TurnEngineInput {
  mode: EndpointingMode;
  expressionState: ExpressionState;
  silenceMs: number;
  completeness: Completeness;
  recentEnergy?: number;
  baseMinPauseMs?: number;
  baseMaxWaitMs?: number;
}

export interface TurnEngineDecision {
  action: TurnEngineAction;
  reason: string;
  minPauseMs: number;
  maxWaitMs: number;
  label: string;
}

export function decideTurn(input: TurnEngineInput): TurnEngineDecision {
  const tuning = resolveEndpointingTuning({
    mode: input.mode,
    expressionState: input.expressionState,
    silenceMs: input.silenceMs,
    completeness: input.completeness,
    ...(input.recentEnergy != null ? { recentEnergy: input.recentEnergy } : {}),
    baseMinPauseMs: input.baseMinPauseMs,
    baseMaxWaitMs: input.baseMaxWaitMs
  });
  const raw = decideCascadeTurn({
    expressionState: input.expressionState,
    silenceMs: input.silenceMs,
    completeness: input.completeness,
    minPauseMs: tuning.minPauseMs,
    maxWaitMs: tuning.maxWaitMs
  });
  const action = applyPvadDecisionBias(raw.action, tuning);
  return {
    action,
    reason: action !== raw.action ? `${raw.reason} + ${tuning.label} bias` : raw.reason,
    minPauseMs: tuning.minPauseMs,
    maxWaitMs: tuning.maxWaitMs,
    label: tuning.label
  };
}
