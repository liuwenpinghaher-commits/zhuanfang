import { createStep, Workflow } from "@mastra/core/workflows";
import { z } from "zod";

const generateScriptStep = new createStep({
  id: "generateScript",
  description: "Generate podcast script from interview content",
  inputSchema: z.object({
    sessionId: z.string(),
    transcript: z.string().optional(),
    topic: z.string().optional(),
    style: z.enum(["conversational", "narrative", "interview"]).default("conversational"),
  }),
  outputSchema: z.object({
    script: z.any(),
  }),
  execute: async ({ inputData }) => {
    return {
      script: {
        title: inputData.topic || "访谈精华播客",
        style: inputData.style,
        segments: [
          {
            type: "intro",
            speaker: "host",
            text: "欢迎收听本期访谈精华播客。今天我们将探讨产品策略的核心议题。",
            duration: 15,
          },
          {
            type: "content",
            speaker: "host",
            text: "在本次访谈中，受访者分享了关于产品决策的深刻见解。",
            duration: 30,
          },
          {
            type: "highlight",
            speaker: "interviewee",
            text: "产品策略的核心在于对99%的机会说不。",
            duration: 10,
          },
          {
            type: "analysis",
            speaker: "host",
            text: "这个观点强调了聚焦和优先级管理在产品管理中的重要性。",
            duration: 20,
          },
          {
            type: "outro",
            speaker: "host",
            text: "感谢收听，我们下期再见。",
            duration: 10,
          },
        ],
        totalDuration: 85,
        wordCount: 150,
      },
    };
  },
});

const synthesizeAudioStep = new createStep({
  id: "synthesizeAudio",
  description: "Synthesize audio from podcast script",
  inputSchema: z.object({
    script: z.any(),
    voice: z.string().default("longyuan_v3"),
    format: z.enum(["mp3", "wav"]).default("mp3"),
  }),
  outputSchema: z.object({
    audioResult: z.any(),
  }),
  execute: async ({ inputData }) => {
    return {
      audioResult: {
        id: "ep_001",
        title: inputData.script.title,
        format: inputData.format,
        voice: inputData.voice,
        duration: inputData.script.totalDuration,
        status: "synthesized",
        url: "https://example.com/podcast/ep_001.mp3",
        createdAt: new Date().toISOString(),
      },
    };
  },
});

export const podcastGenerationWorkflow = new Workflow({
  id: "podcast-generation",
  description: "Generates podcast script then synthesizes audio",
  inputSchema: z.object({
    sessionId: z.string(),
    transcript: z.string().optional(),
    topic: z.string().optional(),
    style: z.enum(["conversational", "narrative", "interview"]).default("conversational"),
    voice: z.string().default("longyuan_v3"),
    format: z.enum(["mp3", "wav"]).default("mp3"),
  }),
  outputSchema: z.object({
    audioResult: z.any(),
  }),
})
  .then(generateScriptStep)
  .then(synthesizeAudioStep)
  .commit();
