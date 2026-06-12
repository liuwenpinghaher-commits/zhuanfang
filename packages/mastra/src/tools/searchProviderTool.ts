import { createTool } from "@mastra/core/tools";
import { z } from "zod";

export const searchProviderTool = createTool({
  id: "searchProvider",
  description:
    "Search the web using configured providers (Bailian, AnySearch, Tavily, Exa, Brave)",
  inputSchema: z.object({
    query: z.string(),
    provider: z
      .enum(["bailian", "anysearch", "tavily", "exa", "brave"])
      .default("bailian"),
    maxResults: z.number().default(5),
  }),
  outputSchema: z.object({
    result: z.any(),
  }),
  execute: async ({ context }) => {
    const { query, provider, maxResults } = context;
    const apiBase =
      process.env.PRODUCT_API_BASE_URL || "http://127.0.0.1:8787";
    const res = await fetch(`${apiBase}/api/search/briefs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic: query, provider, maxSources: maxResults }),
    });
    return { result: await res.json() };
  },
});
