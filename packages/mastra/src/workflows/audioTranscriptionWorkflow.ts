import { createStep, Workflow } from "@mastra/core/workflows";
import { z } from "zod";

const transcribeAudioStep = new createStep({
  id: "transcribeAudio",
  description: "Transcribe audio to text",
  inputSchema: z.object({
    audioUrl: z.string(),
    title: z.string().optional(),
  }),
  outputSchema: z.object({
    transcription: z.any(),
  }),
  execute: async ({ inputData }) => {
    return {
      transcription: {
        id: "trx_001",
        title: inputData.title || "Untitled Audio",
        sourceUrl: inputData.audioUrl,
        text: "这是模拟的转录文本。受访者讨论了产品策略和团队协作的相关话题。",
        language: "zh-CN",
        duration: 3600,
        segments: [
          {
            start: 0,
            end: 60,
            text: "这是模拟的转录文本。",
            confidence: 0.95,
          },
          {
            start: 60,
            end: 120,
            text: "受访者讨论了产品策略和团队协作的相关话题。",
            confidence: 0.92,
          },
        ],
      },
    };
  },
});

const cleanTranscriptStep = new createStep({
  id: "cleanTranscript",
  description: "Clean and normalize the transcribed text",
  inputSchema: z.object({
    transcription: z.any(),
  }),
  outputSchema: z.object({
    cleanedTranscript: z.any(),
  }),
  execute: async ({ inputData }) => {
    const text = inputData.transcription.text || "";
    const cleaned = text.replace(/\s+/g, " ").trim();
    return {
      cleanedTranscript: {
        original: text,
        cleaned,
        wordCount: cleaned.split(/\s+/).length,
        segments: (inputData.transcription.segments || []).map((s: any) => ({
          ...s,
          text: s.text.replace(/\s+/g, " ").trim(),
        })),
      },
    };
  },
});

export const audioTranscriptionWorkflow = new Workflow({
  id: "audio-transcription",
  description: "Transcribes audio then cleans the transcript",
  inputSchema: z.object({
    audioUrl: z.string(),
    title: z.string().optional(),
  }),
  outputSchema: z.object({
    cleanedTranscript: z.any(),
  }),
})
  .then(transcribeAudioStep)
  .then(cleanTranscriptStep)
  .commit();
