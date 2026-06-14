import type { TurnDetector, TurnDetectorContext, TurnDetectorDecision } from "./types";

export interface SilenceVadDetectorOptions {
  silenceThresholdMs: number;
  longPauseThresholdMs: number;
  inputLevelThreshold?: number;
}

export const SILENCE_VAD_DETECTOR_ID = "silence-vad-default";

export function createSilenceVadDetector(options: SilenceVadDetectorOptions): TurnDetector {
  const inputLevelThreshold = options.inputLevelThreshold ?? 0.1;
  return {
    id: SILENCE_VAD_DETECTOR_ID,
    evaluate(ctx: TurnDetectorContext): TurnDetectorDecision {
      const userActive = ctx.inputLevel > inputLevelThreshold || ctx.isUserSpeaking;
      if (userActive && ctx.isAssistantSpeaking) {
        return {
          decision: "interruption",
          confidence: clampConfidence(ctx.inputLevel + 0.4),
          reason: "用户在 agent 说话期间发声，判定为打断"
        };
      }
      if (userActive) {
        return {
          decision: "continue",
          confidence: clampConfidence(ctx.inputLevel + 0.2),
          reason: "检测到用户正在说话"
        };
      }
      if (ctx.silenceMs >= 400 && ctx.silenceMs < 800 && !ctx.isAssistantSpeaking) {
        return {
          decision: "guidance",
          confidence: 0.55,
          reason: `静默 ${ctx.silenceMs}ms 处于引导窗口，可轻推`,
          guidance: {
            kind: "nudge",
            text: "嗯"
          }
        };
      }
      if (ctx.silenceMs >= options.longPauseThresholdMs) {
        return {
          decision: "end_of_turn",
          confidence: 0.85,
          reason: `静默 ${ctx.silenceMs}ms 超过长停顿阈值 ${options.longPauseThresholdMs}ms`
        };
      }
      if (ctx.silenceMs >= options.silenceThresholdMs) {
        return {
          decision: "continue",
          confidence: 0.45,
          reason: `静默 ${ctx.silenceMs}ms 处于短停顿区间，等待长停顿确认`
        };
      }
      return {
        decision: "continue",
        confidence: 0.2,
        reason: "短停顿或静默尚未达到判定阈值"
      };
    }
  };
}

function clampConfidence(value: number) {
  if (Number.isNaN(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}
