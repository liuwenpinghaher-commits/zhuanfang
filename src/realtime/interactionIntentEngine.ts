import type { ExpressionState, IntentDecision, InteractionPreSignals } from "../domain/types";

export interface IntentEngineInput {
  expressionState: ExpressionState;
  preSignals: InteractionPreSignals | null;
  isAssistantSpeaking: boolean;
  partialTranscript: string;
  audioDuration: number;
  /** Current audio energy level (0-1), used for noise detection. */
  energy: number;
  guidanceCountThisTurn: number;
  /** Ms since the last guidance was triggered. */
  timeSinceLastGuidance: number;
  guidanceEnabled: boolean;
  guidanceBudget: {
    maxPerTurn: number;
    minIntervalMs: number;
  };
}

export function evaluateIntent(input: IntentEngineInput): IntentDecision {
  const { expressionState, preSignals, isAssistantSpeaking, partialTranscript,
    audioDuration, energy, guidanceCountThisTurn, timeSinceLastGuidance,
    guidanceEnabled, guidanceBudget } = input;

  if (isAssistantSpeaking) {
    return evaluateDuringAssistant(preSignals, partialTranscript, audioDuration, energy);
  }
  return evaluateDuringUser(expressionState, preSignals, guidanceCountThisTurn,
    timeSinceLastGuidance, guidanceEnabled, guidanceBudget);
}

function evaluateDuringUser(
  expressionState: ExpressionState,
  preSignals: InteractionPreSignals | null,
  guidanceCountThisTurn: number,
  timeSinceLastGuidance: number,
  guidanceEnabled: boolean,
  guidanceBudget: { maxPerTurn: number; minIntervalMs: number },
): IntentDecision {
  const budgetExhausted = guidanceCountThisTurn >= guidanceBudget.maxPerTurn;
  const tooSoon = timeSinceLastGuidance < guidanceBudget.minIntervalMs;
  const canGuide = guidanceEnabled && !budgetExhausted && !tooSoon;

  // fluent / organizing / concluding → don't intervene
  if (expressionState === "fluent" || expressionState === "organizing" || expressionState === "concluding") {
    return { intent: "backchannel", confidence: 0.9, action: "continue" };
  }

  // hesitating → check depth direction or use nudge
  if (expressionState === "hesitating") {
    if (canGuide && preSignals?.depthDirection) {
      return {
        intent: "guidance",
        confidence: 0.82,
        action: "nudge",
        detail: { text: preSignals.depthDirection.guidance },
      };
    }
    if (canGuide) {
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
    if (canGuide) {
      return {
        intent: "guidance",
        confidence: 0.75,
        action: "nudge",
        detail: { text: "到目前为止，核心是..." },
      };
    }
    return { intent: "backchannel", confidence: 0.4, action: "continue" };
  }

  // emotional → empathy
  if (expressionState === "emotional") {
    if (canGuide) {
      return {
        intent: "guidance",
        confidence: 0.75,
        action: "nudge",
        detail: { text: "这确实让人很疲惫" },
      };
    }
    return { intent: "backchannel", confidence: 0.4, action: "continue" };
  }

  return { intent: "backchannel", confidence: 0.7, action: "continue" };
}

function evaluateDuringAssistant(
  preSignals: InteractionPreSignals | null,
  partialTranscript: string,
  audioDuration: number,
  energy: number,
): IntentDecision {
  // noise: very short (< 200ms) AND low energy → ignore
  if (audioDuration < 200 && energy < 0.1) {
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
