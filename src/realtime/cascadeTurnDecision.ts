import type { ExpressionState, InteractionPreSignals } from "../domain/types";

export interface CascadeTurnInput {
  expressionState: ExpressionState;
  silenceMs: number;
  preSignals: InteractionPreSignals | null;
  maxWaitMs?: number;   // 兜底：静默超过此值也回应（默认 3500）
  minPauseMs?: number;  // 低于此值一律 wait（默认 600）
}
export interface CascadeTurnDecision {
  action: "respond" | "wait" | "backchannel";
  backchannelText?: string;
  reason: string;
}

export function decideCascadeTurn(input: CascadeTurnInput): CascadeTurnDecision {
  const maxWait = input.maxWaitMs ?? 3500;
  const minPause = input.minPauseMs ?? 600;
  if (input.silenceMs >= maxWait) return { action: "respond", reason: "max-wait safety" };
  if (input.silenceMs < minPause) return { action: "wait", reason: "pause too short" };
  switch (input.expressionState) {
    case "concluding": return { action: "respond", reason: "user concluded a thought" };
    case "circling":   return { action: "backchannel", backchannelText: "到目前为止，核心是……", reason: "circling → nudge summary" };
    case "emotional":  return { action: "backchannel", backchannelText: "嗯，我在听。", reason: "emotional → empathy" };
    case "hesitating":
    case "organizing":
    case "fluent":
    default:           return { action: "wait", reason: "mid-thought → 留白" };
  }
}
