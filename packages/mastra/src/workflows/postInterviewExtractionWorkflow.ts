import { createStep, Workflow } from "@mastra/core/workflows";
import { z } from "zod";

const extractAssetsStep = new createStep({
  id: "extractAssets",
  description: "Extract assets from interview transcript",
  inputSchema: z.object({
    sessionId: z.string(),
    transcript: z.string(),
  }),
  outputSchema: z.object({
    assets: z.any(),
  }),
  execute: async ({ inputData }) => {
    return {
      assets: {
        quotes: [
          {
            text: "Product strategy is about saying no to 99% of opportunities.",
            speaker: "interviewee",
            timestamp: "00:05:23",
          },
        ],
        insights: [
          {
            category: "decision_making",
            content: "Uses data-driven framework for prioritization",
            confidence: 0.85,
          },
        ],
        entities: [
          { name: "Product Strategy Framework", type: "methodology" },
          { name: "GTM Playbook", type: "document" },
        ],
      },
    };
  },
});

const generateMemoryCandidatesStep = new createStep({
  id: "generateMemoryCandidates",
  description: "Generate memory candidates from interview content",
  inputSchema: z.object({
    sessionId: z.string(),
    transcript: z.string(),
    assets: z.any(),
  }),
  outputSchema: z.object({
    memoryCandidates: z.any(),
  }),
  execute: async ({ inputData }) => {
    return {
      memoryCandidates: {
        candidates: [
          {
            id: "mc_001",
            type: "fact",
            content: "Interviewee prioritizes using a data-driven framework",
            confidence: 0.9,
            source: "session-post-extraction",
            importance: "high",
          },
          {
            id: "mc_002",
            type: "insight",
            content: "Shows strong bias toward quantitative over qualitative data",
            confidence: 0.75,
            source: "session-post-extraction",
            importance: "medium",
          },
        ],
        totalCandidates: 2,
      },
    };
  },
});

const analyzeTechniqueStep = new createStep({
  id: "analyzeTechnique",
  description: "Analyze interview technique and provide feedback",
  inputSchema: z.object({
    sessionId: z.string(),
    transcript: z.string(),
  }),
  outputSchema: z.object({
    techniqueAnalysis: z.any(),
  }),
  execute: async ({ inputData }) => {
    return {
      techniqueAnalysis: {
        overallScore: 7.5,
        dimensions: {
          questionQuality: 8,
          followUpEffectiveness: 7,
          rapportBuilding: 8,
          topicCoverage: 7,
          activeListening: 7.5,
        },
        strengths: [
          "Good use of open-ended questions",
          "Effective paraphrasing of interviewee responses",
        ],
        improvements: [
          "Could use more silence to let interviewee elaborate",
          "Some leading questions detected in turn 5-7",
        ],
        recommendations: [
          "Practice the '5-second rule' after asking questions",
          "Use more neutral phrasing for follow-up questions",
        ],
      },
    };
  },
});

export const postInterviewExtractionWorkflow = new Workflow({
  id: "post-interview-extraction",
  description: "Extracts assets, generates memory candidates, and analyzes interview technique",
  inputSchema: z.object({
    sessionId: z.string(),
    transcript: z.string(),
  }),
  outputSchema: z.object({
    assets: z.any(),
    memoryCandidates: z.any(),
    techniqueAnalysis: z.any(),
  }),
})
  .then(extractAssetsStep)
  .then(generateMemoryCandidatesStep)
  .then(analyzeTechniqueStep)
  .commit();
