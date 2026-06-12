import { createStep, Workflow } from "@mastra/core/workflows";
import { z } from "zod";

const consolidateMemoriesStep = new createStep({
  id: "consolidateMemories",
  description: "Consolidate related memories and remove duplicates",
  inputSchema: z.object({
    intervieweeId: z.string(),
    dryRun: z.boolean().default(false),
  }),
  outputSchema: z.object({
    consolidationResult: z.any(),
  }),
  execute: async ({ inputData }) => {
    return {
      consolidationResult: {
        intervieweeId: inputData.intervieweeId,
        dryRun: inputData.dryRun,
        merged: [
          {
            action: "merge",
            sourceIds: ["mem_001", "mem_003"],
            newContent: "Interviewee consistently uses data-driven frameworks for product decisions",
            reason: "Duplicate insight with minor variations",
          },
        ],
        archived: [
          {
            id: "mem_005",
            reason: "Outdated information superseded by newer memory",
          },
        ],
        strengthened: [
          {
            id: "mem_002",
            newConfidence: 0.95,
            reason: "Corroborated by multiple sessions",
          },
        ],
        summary: {
          totalProcessed: 50,
          merged: 1,
          archived: 1,
          strengthened: 1,
          unchanged: 47,
        },
      },
    };
  },
});

const discoverNewCandidatesStep = new createStep({
  id: "discoverNewCandidates",
  description: "Discover new memory candidates from consolidated data",
  inputSchema: z.object({
    consolidationResult: z.any(),
    intervieweeId: z.string(),
  }),
  outputSchema: z.object({
    newCandidates: z.any(),
  }),
  execute: async ({ inputData }) => {
    return {
      newCandidates: {
        candidates: [
          {
            id: "mc_new_001",
            type: "pattern",
            content: "Shows increasing preference for async communication over meetings",
            confidence: 0.7,
            source: "cross-session-analysis",
            importance: "medium",
          },
          {
            id: "mc_new_002",
            type: "insight",
            content: "Decision-making speed increases when working with familiar teams",
            confidence: 0.65,
            source: "cross-session-analysis",
            importance: "low",
          },
        ],
        totalDiscovered: 2,
        discoveredAt: new Date().toISOString(),
      },
    };
  },
});

export const memoryMaintenanceWorkflow = new Workflow({
  id: "memory-maintenance",
  description: "Consolidates memories and discovers new memory candidates",
  inputSchema: z.object({
    intervieweeId: z.string(),
    dryRun: z.boolean().default(false),
  }),
  outputSchema: z.object({
    consolidationResult: z.any(),
    newCandidates: z.any(),
  }),
})
  .then(consolidateMemoriesStep)
  .then(discoverNewCandidatesStep)
  .commit();
