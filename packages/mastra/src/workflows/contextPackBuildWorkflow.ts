import { createStep, Workflow } from "@mastra/core/workflows";
import { z } from "zod";

const buildContextPackStep = new createStep({
  id: "buildContextPack",
  description: "Build a structured context pack for interview preparation",
  inputSchema: z.object({
    intervieweeId: z.string(),
    includeMemories: z.boolean().default(true),
    includeThemes: z.boolean().default(true),
  }),
  outputSchema: z.object({
    contextPack: z.any(),
  }),
  execute: async ({ inputData }) => {
    return {
      contextPack: {
        profile: {
          name: "Demo Interviewee",
          role: "Product Manager",
          background: "10 years experience in SaaS products",
          expertise: ["product strategy", "user research", "agile"],
        },
        memories: inputData.includeMemories
          ? {
              core: ["Previously discussed product-market fit challenges"],
              recent: ["Last session covered pricing strategy"],
              count: 42,
            }
          : { core: [], recent: [], count: 0 },
        themes: inputData.includeThemes
          ? [
              {
                name: "Product Strategy",
                status: "active",
                summary: "Exploring go-to-market approaches",
                relatedEntities: ["GTM", "pricing"],
              },
            ]
          : [],
        knowledgeDebts: [
          {
            id: "kd_001",
            description: "Need to verify competitive landscape data",
            priority: "high",
            source: "session-003",
          },
        ],
        pendingQuestions: [
          {
            id: "pq_001",
            text: "How does the team handle conflicting stakeholder feedback?",
            context: "Mentioned in session-002",
          },
        ],
        recentNotes: ["Interviewee showed strong analytical thinking"],
        summary: "Experienced PM with deep SaaS knowledge, currently exploring product strategy refinements.",
      },
    };
  },
});

export const contextPackBuildWorkflow = new Workflow({
  id: "context-pack-build",
  description: "Builds a context pack for interview preparation",
  inputSchema: z.object({
    intervieweeId: z.string(),
    includeMemories: z.boolean().default(true),
    includeThemes: z.boolean().default(true),
  }),
  outputSchema: z.object({
    contextPack: z.any(),
  }),
})
  .then(buildContextPackStep)
  .commit();
