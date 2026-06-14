import type { ExpressionState, IntentDecision, InteractionPreSignals } from "../domain/types";

export interface IntentEngineInput {
  expressionState: ExpressionState;
  preSignals: InteractionPreSignals | null;
  isAssistantSpeaking: boolean;
  partialTranscript: string;
  audioDuration: number;
  guidanceCountThisTurn: number;
  guidanceBudget: {
    maxPerTurn: number;
    minIntervalMs: number;
  };
}

export function evaluateIntent(input: IntentEngineInput): IntentDecision {
  const { expressionState, preSignals, isAssistantSpeaking, partialTranscript,
    audioDuration, guidanceCountThisTurn, guidanceBudget } = input;

  if (isAssistantSpeaking) {
    return evaluateDuringAssistant(expressionState, preSignals, partialTranscript, audioDuration);
  }
  return evaluateDuringUser(expressionState, preSignals, guidanceCountThisTurn, guidanceBudget);
}

function evaluateDuringUser(
  expressionState: ExpressionState,
  preSignals: InteractionPreSignals | null,
  guidanceCountThisTurn: number,
  guidanceBudget: { maxPerTurn: number; minIntervalMs: number },
): IntentDecision {
  // fluent / organizing / concluding → don't intervene
  if (expressionState === "fluent" || expressionState === "organizing" || expressionState === "concluding") {
    return { intent: "backchannel", confidence: 0.9, action: "continue" };
  }

  // hesitating → check depth direction or use nudge
  if (expressionState === "hesitating") {
    if (preSignals?.depthDirection) {
      return {
        intent: "guidance",
        confidence: 0.82,
        action: "nudge",
        detail: { text: preSignals.depthDirection.guidance },
      };
    }
    if (guidanceCountThisTurn < guidanceBudget.maxPerTurn) {
      return {
        intent: "guidance",
        confidence: 0.6,
        action: "nudge",
        detail: { text: "嗯" },
      };
    }
    return { intent: "backchannel", confidence: 0.5, action: "continue" };
  }

  // circling → stage summary
  if (expressionState === "circling") {
    return {
      intent: "guidance",
      confidence: 0.75,
      action: "nudge",
      detail: { text: "到目前为止，核心是..." },
    };
  }

  // emotional → empathy
  if (expressionState === "emotional") {
    return {
      intent: "guidance",
      confidence: 0.75,
      action: "nudge",
      detail: { text: "这确实让人很疲惫" },
    };
  }

  return { intent: "backchannel", confidence: 0.7, action: "continue" };
}

function evaluateDuringAssistant(
  _expressionState: ExpressionState,
  preSignals: InteractionPreSignals | null,
  partialTranscript: string,
  audioDuration: number,
): IntentDecision {
  // noise: very short + low energy → ignore
  if (audioDuration < 200) {
    return { intent: "noise", confidence: 0.85, action: "ignore" };
  }

  // backchannel: short + matches whitelist
  if (audioDuration < 500 && preSignals) {
    const trimmed = partialTranscript.trim();
    const matched = preSignals.backchannelWhitelist.some((w) => trimmed.includes(w));
    if (matched) {
      return { intent: "backchannel", confidence: 0.8, action: "continue" };
    }
  }

  // interrupt: matches trigger words
  if (preSignals) {
    const trimmed = partialTranscript.trim();
    const triggered = preSignals.interruptTriggers.some((w) => trimmed.includes(w));
    if (triggered) {
      return { intent: "interruption", confidence: 0.9, action: "stop" };
    }
  }

  // long sentence → sensitivity-based
  if (audioDuration > 1500 && preSignals) {
    if (preSignals.interruptSensitivity === "high") {
      return { intent: "interruption", confidence: 0.7, action: "stop" };
    }
    if (preSignals.interruptSensitivity === "medium" && audioDuration > 2000) {
      return { intent: "interruption", confidence: 0.6, action: "stop" };
    }
    // low sensitivity → backchannel
    return { intent: "backchannel", confidence: 0.6, action: "continue" };
  }

  return { intent: "backchannel", confidence: 0.5, action: "continue" };
}
