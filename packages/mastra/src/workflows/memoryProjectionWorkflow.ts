import { createStep, Workflow } from "@mastra/core/workflows";
import { z } from "zod";

const projectMemoriesStep = new createStep({
  id: "projectMemories",
  description: "Project memories to working memory for active use",
  inputSchema: z.object({
    intervieweeId: z.string(),
    sessionId: z.string().optional(),
    memoryIds: z.array(z.string()).optional(),
  }),
  outputSchema: z.object({
    workingMemory: z.any(),
  }),
  execute: async ({ inputData }) => {
    return {
      workingMemory: {
        projectedMemories: [
          {
            id: "mem_001",
            type: "fact",
            content: "Interviewee prefers visual data representations",
            projectedAt: new Date().toISOString(),
            ttl: 3600,
          },
          {
            id: "mem_002",
            type: "insight",
            content: "Has strong opinions about agile vs waterfall",
            projectedAt: new Date().toISOString(),
            ttl: 3600,
          },
        ],
        recentSessions: [
          {
            id: "session-003",
            date: "2025-06-10",
            summary: "Discussed product roadmap priorities",
          },
        ],
        activeThemes: [
          {
            name: "Product Strategy",
            maturity: "developing",
            lastUpdated: "2025-06-10",
          },
        ],
        openDebts: [
          {
            id: "kd_001",
            description: "Verify competitive landscape data",
            status: "open",
          },
        ],
      },
    };
  },
});

export const memoryProjectionWorkflow = new Workflow({
  id: "memory-projection",
  description: "Projects memories to working memory for active use in interviews",
  inputSchema: z.object({
    intervieweeId: z.string(),
    sessionId: z.string().optional(),
    memoryIds: z.array(z.string()).optional(),
  }),
  outputSchema: z.object({
    workingMemory: z.any(),
  }),
})
  .then(projectMemoriesStep)
  .commit();
