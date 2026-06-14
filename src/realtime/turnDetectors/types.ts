export interface TurnDetectorContext {
  inputLevel: number;
  silenceMs: number;
  isUserSpeaking: boolean;
  isAssistantSpeaking: boolean;
  transcript?: string;
}

export type TurnDetectorDecisionKind = "continue" | "end_of_turn" | "interruption" | "guidance";

export interface TurnDetectorDecision {
  decision: TurnDetectorDecisionKind;
  confidence: number;
  reason: string;
  guidance?: {
    kind: string;
    text: string;
    anchor?: string;
  };
}

export interface TurnDetector {
  readonly id: string;
  evaluate(ctx: TurnDetectorContext): TurnDetectorDecision;
}
