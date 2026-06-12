import { createStep, Workflow } from "@mastra/core/workflows";
import { z } from "zod";

const classifyReferenceStep = new createStep({
  id: "classifyReference",
  description: "Classify the reference interview and extract metadata",
  inputSchema: z.object({
    referenceUrl: z.string(),
    referenceContent: z.string().optional(),
  }),
  outputSchema: z.object({
    classification: z.any(),
  }),
  execute: async ({ inputData }) => {
    return {
      classification: {
        importType: "reference_interview",
        confidence: 0.95,
        metadata: {
          source: inputData.referenceUrl,
          domain: "technology",
          interviewStyle: "conversational",
          estimatedLength: inputData.referenceContent?.length || 0,
        },
        tags: ["reference", "learning", "technique-analysis"],
      },
    };
  },
});

const extractLearnablePatternsStep = new createStep({
  id: "extractLearnablePatterns",
  description: "Extract learnable patterns from reference interview",
  inputSchema: z.object({
    classification: z.any(),
    referenceContent: z.string().optional(),
  }),
  outputSchema: z.object({
    learnablePatterns: z.any(),
  }),
  execute: async ({ inputData }) => {
    return {
      learnablePatterns: {
        questionPatterns: [
          {
            id: "qp_001",
            pattern: "Start with broad context, then narrow down",
            effectiveness: "high",
            examples: ["先问行业趋势，再问个人实践"],
          },
          {
            id: "qp_002",
            pattern: "Use silence strategically after key questions",
            effectiveness: "medium",
            examples: ["提问后停顿5秒，给受访者思考空间"],
          },
        ],
        followUpTechniques: [
          {
            id: "ft_001",
            technique: "Echo technique - repeat last phrase as question",
            usage: "When interviewee gives a vague answer",
          },
        ],
        structuralInsights: [
          {
            id: "si_001",
            insight: "Interview flows from general to specific to reflective",
            applicableTo: ["expert_interviews", "career_retrospectives"],
          },
        ],
        keyTakeaways: [
          "Build rapport before challenging questions",
          "Document non-verbal cues alongside verbal responses",
        ],
      },
    };
  },
});

export const referenceInterviewLearningWorkflow = new Workflow({
  id: "reference-interview-learning",
  description: "Classifies reference interview and extracts learnable patterns",
  inputSchema: z.object({
    referenceUrl: z.string(),
    referenceContent: z.string().optional(),
  }),
  outputSchema: z.object({
    classification: z.any(),
    learnablePatterns: z.any(),
  }),
})
  .then(classifyReferenceStep)
  .then(extractLearnablePatternsStep)
  .commit();
