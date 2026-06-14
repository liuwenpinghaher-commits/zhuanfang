import type { ExpressionState } from "../domain/types";

export interface ExpressionStateInput {
  speechRate: number;
  baselineSpeechRate: number;
  energy: number;
  baselineEnergy: number;
  pitchTrend: "rising" | "falling" | "flat";
  currentSilenceMs: number;
  pausePosition: "grammar_boundary" | "mid_clause" | "sentence_start";
  hasFilledPause: boolean;
  hasRepetition: boolean;
  hasFalseStart: boolean;
  hasVagueTerm: boolean;
  hasEmotionWord: boolean;
  samePointCount: number;
  timeSinceLastGuidance: number;
}

export interface ExpressionStateDetector {
  evaluate(input: ExpressionStateInput): ExpressionState;
}

export function createExpressionStateDetector(): ExpressionStateDetector {
  let baselineSpeechRate = 0;
  let baselineEnergy = 0;
  let baselineCount = 0;

  function updateBaseline(speechRate: number, energy: number) {
    if (baselineCount < 3) {
      baselineSpeechRate = (baselineSpeechRate * baselineCount + speechRate) / (baselineCount + 1);
      baselineEnergy = (baselineEnergy * baselineCount + energy) / (baselineCount + 1);
      baselineCount++;
    }
  }

  return {
    evaluate(input) {
      updateBaseline(input.speechRate, input.energy);

      const sr = input.speechRate || baselineSpeechRate;
      const blSR = baselineSpeechRate || sr;
      const energy = input.energy || baselineEnergy;
      const blEnergy = baselineEnergy || energy;

      // emotional: emotion words + (high energy OR flat pitch)
      if (input.hasEmotionWord && (energy > 1.3 * blEnergy || input.pitchTrend === "flat")) {
        return "emotional";
      }

      // circling: same point repeated >= 2 times
      if (input.samePointCount >= 2) {
        return "circling";
      }

      // concluding: falling pitch + long pause
      if (input.pitchTrend === "falling" && input.currentSilenceMs >= 800) {
        return "concluding";
      }

      // hesitating: (vague term OR repetition OR false start) + pause >= 500ms + mid-clause
      const hasDisfluency = input.hasVagueTerm || input.hasRepetition || input.hasFalseStart;
      if (hasDisfluency && input.currentSilenceMs >= 500 && input.pausePosition === "mid_clause") {
        return "hesitating";
      }

      // organizing: filled pause + pause < 800ms + no vague terms + no repetition
      //   but only when the pause is NOT at a grammar boundary (which would be fluent)
      if (input.hasFilledPause && input.currentSilenceMs < 800 && !input.hasVagueTerm && !input.hasRepetition
          && input.pausePosition !== "grammar_boundary") {
        return "organizing";
      }

      // fluent: default
      return "fluent";
    }
  };
}
