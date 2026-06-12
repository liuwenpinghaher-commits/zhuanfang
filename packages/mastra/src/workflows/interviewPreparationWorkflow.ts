import { createStep, Workflow } from "@mastra/core/workflows";
import { z } from "zod";

const buildContextPackStep = new createStep({
  id: "buildContextPack",
  description: "Build context pack for the interviewee",
  inputSchema: z.object({
    intervieweeId: z.string(),
    sessionId: z.string().optional(),
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
        memories: {
          core: ["Previously discussed product-market fit challenges"],
          recent: ["Last session covered pricing strategy"],
          count: 42,
        },
        themes: [
          {
            name: "Product Strategy",
            status: "active",
            summary: "Exploring go-to-market approaches",
            relatedEntities: ["GTM", "pricing"],
          },
        ],
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

const generateOpeningQuestionStep = new createStep({
  id: "generateOpeningQuestion",
  description: "Generate opening interview question based on context pack",
  inputSchema: z.object({
    contextPack: z.any(),
  }),
  outputSchema: z.object({
    openingQuestion: z.any(),
    sessionStrategy: z.string(),
  }),
  execute: async ({ inputData }) => {
    return {
      openingQuestion: {
        id: "q_001",
        type: "main",
        parentId: null,
        text: "基于你过去10年的SaaS产品经验，你认为当前产品策略中最大的挑战是什么？",
        rationale: "从受访者核心专业领域切入，建立信任和对话节奏",
        expectedTopics: ["product strategy", "challenges"],
        priority: 1,
      },
      sessionStrategy: "从受访者熟悉的领域开始，逐步深入到具体案例和反思性问题",
    };
  },
});

export const interviewPreparationWorkflow = new Workflow({
  id: "interview-preparation",
  description: "Builds context pack then generates opening question for interview preparation",
  inputSchema: z.object({
    intervieweeId: z.string(),
    sessionId: z.string().optional(),
  }),
  outputSchema: z.object({
    openingQuestion: z.any(),
    sessionStrategy: z.string(),
  }),
})
  .then(buildContextPackStep)
  .then(generateOpeningQuestionStep)
  .commit();
