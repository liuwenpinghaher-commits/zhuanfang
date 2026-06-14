export interface TurnDetectorContext {
  inputLevel: number;
  silenceMs: number;
  isUserSpeaking: boolean;
  isAssistantSpeaking: boolean;
  transcript?: string;
}

export type TurnDetectorDecisionKind = "continue" | "end_of_turn" | "interruption";

export interface TurnDetectorDecision {
  decision: TurnDetectorDecisionKind;
  confidence: number;
  reason: string;
}

export interface TurnDetector {
  readonly id: string;
  evaluate(ctx: TurnDetectorContext): TurnDetectorDecision;
}
