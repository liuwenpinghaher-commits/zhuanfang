import type { InterviewCard, InterviewEnginePolicy, InterviewGuide, InterviewSession } from "./types";

/**
 * Mid-session guide/card refresh must never clobber turns (or strategyTrace)
 * recorded after the refresh path read its base snapshot (IV-P0-01/02).
 * Field-level merge: keep latest session spine, replace only guide/card/enginePolicy.
 */
export function mergeInterviewSessionRefresh(
  latest: InterviewSession,
  patch: {
    guide: InterviewGuide;
    card: InterviewCard;
    enginePolicy?: InterviewEnginePolicy;
  }
): InterviewSession {
  return {
    ...latest,
    guide: patch.guide,
    card: patch.card,
    ...(patch.enginePolicy ? { enginePolicy: patch.enginePolicy } : {})
  };
}
