import { createTool } from "@mastra/core/tools";
import { z } from "zod";

export const ttsTool = createTool({
  id: "tts",
  description: "Synthesize speech from text via the Product API podcast/episodes endpoint",
  inputSchema: z.object({
    text: z.string(),
    voice: z.string().default("longyuan_v3"),
    format: z.enum(["mp3", "wav"]).default("mp3"),
  }),
  outputSchema: z.object({
    result: z.any(),
  }),
  execute: async ({ context }) => {
    const { text, voice, format } = context;
    const apiBase =
      process.env.PRODUCT_API_BASE_URL || "http://127.0.0.1:8787";
    const res = await fetch(`${apiBase}/api/podcast/episodes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        noteId: "tts-direct",
        voice,
        format,
        script: text,
      }),
    });
    return { result: await res.json() };
  },
});
