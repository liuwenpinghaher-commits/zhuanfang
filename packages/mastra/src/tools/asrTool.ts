import { createTool } from "@mastra/core/tools";
import { z } from "zod";

export const asrTool = createTool({
  id: "asr",
  description: "Transcribe audio to text via the Product API corpus/transcriptions endpoint",
  inputSchema: z.object({
    audioUrl: z.string(),
    title: z.string().optional(),
  }),
  outputSchema: z.object({
    result: z.any(),
  }),
  execute: async ({ context }) => {
    const { audioUrl, title } = context;
    const apiBase =
      process.env.PRODUCT_API_BASE_URL || "http://127.0.0.1:8787";
    const res = await fetch(`${apiBase}/api/corpus/transcriptions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceUrl: audioUrl, title: title || "audio" }),
    });
    return { result: await res.json() };
  },
});
