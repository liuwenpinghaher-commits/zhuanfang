import { createStep, Workflow } from "@mastra/core/workflows";
import { z } from "zod";

const generateNextMoveStep = new createStep({
  id: "generateNextMove",
  description: "Generate the next interview move based on current turn and session context",
  inputSchema: z.object({
    sessionId: z.string(),
    currentTurn: z.number(),
    lastResponse: z.string(),
    contextPack: z.any().optional(),
  }),
  outputSchema: z.object({
    nextMove: z.any(),
    reasoning: z.string(),
  }),
  execute: async ({ inputData }) => {
    const isEarlyStage = inputData.currentTurn <= 3;
    return {
      nextMove: {
        id: `q_${String(inputData.currentTurn + 1).padStart(3, "0")}`,
        type: isEarlyStage ? "main" : "follow_up",
        parentId: isEarlyStage ? null : `q_${String(inputData.currentTurn).padStart(3, "0")}`,
        text: isEarlyStage
          ? "能否分享一个具体的案例，说明你是如何推动产品决策的？"
          : "你提到的那次决策过程中，有没有遇到团队内部的阻力？",
        rationale: isEarlyStage
          ? "从抽象过渡到具体案例，获取可分析的细节"
          : "深入挖掘决策过程中的冲突和解决方案",
        expectedTopics: ["decision making", "team dynamics"],
        priority: 2,
      },
      reasoning: isEarlyStage
        ? "Early stage: building rapport and gathering concrete examples"
        : "Mid-stage: probing deeper into decision-making processes",
    };
  },
});

export const liveInterviewAssistWorkflow = new Workflow({
  id: "live-interview-assist",
  description: "Generates next interview move based on current turn and session context",
  inputSchema: z.object({
    sessionId: z.string(),
    currentTurn: z.number(),
    lastResponse: z.string(),
    contextPack: z.any().optional(),
  }),
  outputSchema: z.object({
    nextMove: z.any(),
    reasoning: z.string(),
  }),
})
  .then(generateNextMoveStep)
  .commit();
