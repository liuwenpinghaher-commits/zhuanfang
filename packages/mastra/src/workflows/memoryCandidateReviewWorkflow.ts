import { createStep, Workflow } from "@mastra/core/workflows";
import { z } from "zod";

const scoreCandidatesStep = new createStep({
  id: "scoreCandidates",
  description: "Score memory candidates for quality and relevance",
  inputSchema: z.object({
    candidates: z.array(z.any()),
  }),
  outputSchema: z.object({
    scoredCandidates: z.any(),
  }),
  execute: async ({ inputData }) => {
    const scored = inputData.candidates.map((c: any) => ({
      ...c,
      score: c.importance === "high" ? 0.9 : c.importance === "medium" ? 0.7 : 0.5,
      scoredAt: new Date().toISOString(),
    }));
    return {
      scoredCandidates: {
        candidates: scored,
        averageScore:
          scored.reduce((sum: number, c: any) => sum + c.score, 0) / scored.length,
        total: scored.length,
      },
    };
  },
});

const checkConsolidationStep = new createStep({
  id: "checkConsolidation",
  description: "Check if memories should be consolidated",
  inputSchema: z.object({
    scoredCandidates: z.any(),
  }),
  outputSchema: z.object({
    consolidationPlan: z.any(),
  }),
  execute: async ({ inputData }) => {
    const candidates = inputData.scoredCandidates.candidates || [];
    const toConsolidate = candidates.filter((c: any) => c.score >= 0.8);
    const toReview = candidates.filter((c: any) => c.score >= 0.5 && c.score < 0.8);
    const toDiscard = candidates.filter((c: any) => c.score < 0.5);
    return {
      consolidationPlan: {
        toConsolidate: toConsolidate.map((c: any) => c.id),
        toReview: toReview.map((c: any) => c.id),
        toDiscard: toDiscard.map((c: any) => c.id),
        summary: `${toConsolidate.length} to consolidate, ${toReview.length} to review, ${toDiscard.length} to discard`,
      },
    };
  },
});

const reviewSensitivityStep = new createStep({
  id: "reviewSensitivity",
  description: "Review memory candidates for sensitive content",
  inputSchema: z.object({
    scoredCandidates: z.any(),
    consolidationPlan: z.any(),
  }),
  outputSchema: z.object({
    sensitivityReview: z.any(),
  }),
  execute: async ({ inputData }) => {
    const candidates = inputData.scoredCandidates.candidates || [];
    const flagged = candidates.filter((c: any) =>
      ["personal", "financial", "health"].includes(c.type),
    );
    return {
      sensitivityReview: {
        flagged: flagged.map((c: any) => ({
          id: c.id,
          reason: `Contains ${c.type} information`,
          action: "review_required",
        })),
        safeCount: candidates.length - flagged.length,
        requiresHumanReview: flagged.length > 0,
      },
    };
  },
});

export const memoryCandidateReviewWorkflow = new Workflow({
  id: "memory-candidate-review",
  description: "Scores candidates, checks consolidation, and reviews sensitivity",
  inputSchema: z.object({
    candidates: z.array(z.any()),
  }),
  outputSchema: z.object({
    scoredCandidates: z.any(),
    consolidationPlan: z.any(),
    sensitivityReview: z.any(),
  }),
})
  .then(scoreCandidatesStep)
  .then(checkConsolidationStep)
  .then(reviewSensitivityStep)
  .commit();
