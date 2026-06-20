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

/**
 * EMA smoothing factor for the running baseline (P2-15).
 *
 * The old detector froze the baseline after the first 3 frames, so an unusual
 * opening (a loud throat-clear, an abnormally fast/slow first sentence) anchored
 * the baseline for the entire session and drifted every later judgement. An
 * exponential moving average keeps adapting forever while staying stable:
 *   baseline ← α·new + (1−α)·baseline
 * α=0.05 ≈ a ~20-frame (~5s at 256ms/frame) effective window — slow enough that
 * a single outlier barely moves it, responsive enough to track real drift over a
 * long interview.
 */
const BASELINE_EMA_ALPHA = 0.05;

export function createExpressionStateDetector(): ExpressionStateDetector {
  let baselineSpeechRate = 0;
  let baselineEnergy = 0;
  // Tracks whether the baseline has been seeded yet. The very first frame seeds
  // the baseline directly (not blended against the initial 0, which would halve
  // it); every subsequent frame blends via EMA.
  let baselineSeeded = false;

  function updateBaseline(speechRate: number, energy: number) {
    if (!baselineSeeded) {
      baselineSpeechRate = speechRate;
      baselineEnergy = energy;
      baselineSeeded = true;
      return;
    }
    baselineSpeechRate = BASELINE_EMA_ALPHA * speechRate + (1 - BASELINE_EMA_ALPHA) * baselineSpeechRate;
    baselineEnergy = BASELINE_EMA_ALPHA * energy + (1 - BASELINE_EMA_ALPHA) * baselineEnergy;
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

      // fluent: checked before organizing so that filled pauses at grammar
      //         boundaries (natural in fluent speech) don't trigger organizing.
      // (!baselineSeeded is always false here — updateBaseline() seeds above on
      // the first frame — but kept explicit so the "no baseline yet" intent is
      // clear and the comparison never runs against an unseeded 0 baseline.)
      const rateOk = !baselineSeeded || sr >= 0.8 * blSR;
      const silenceOk = input.currentSilenceMs < 500;
      const boundaryOk = input.pausePosition === "grammar_boundary";
      const noDisfluency = !input.hasRepetition && !input.hasFalseStart;

      if (rateOk && silenceOk && boundaryOk && noDisfluency) {
        return "fluent";
      }

      // organizing: filled pause + pause < 800ms + no vague terms + no repetition
      if (input.hasFilledPause && input.currentSilenceMs < 800 && !input.hasVagueTerm && !input.hasRepetition) {
        return "organizing";
      }

      // Fell through — not fluent and not clearly organizing.
      return "organizing";
    }
  };
}
