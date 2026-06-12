import { createTool } from "@mastra/core/tools";
import { z } from "zod";

export const ragTool = createTool({
  id: "rag",
  description:
    "Semantic search over ragChunks in the product state",
  inputSchema: z.object({
    query: z.string(),
    topK: z.number().default(5),
    filterSourceType: z
      .enum(["interview", "document", "audio", "all"])
      .default("all"),
  }),
  outputSchema: z.object({
    query: z.string(),
    results: z.array(z.any()),
  }),
  execute: async ({ context }) => {
    const { query, topK, filterSourceType } = context;
    const apiBase =
      process.env.PRODUCT_API_BASE_URL || "http://127.0.0.1:8787";
    const state = await fetch(`${apiBase}/api/state`).then((r) => r.json());
    const chunks = (state.ragChunks || []).filter((c: any) =>
      filterSourceType === "all" ? true : c.sourceType === filterSourceType,
    );
    return {
      query,
      results: chunks.slice(0, topK).map((c: any) => ({
        content: c.content,
        sourceType: c.sourceType,
        sourceId: c.sourceId,
        metadata: c.metadata,
      })),
    };
  },
});
