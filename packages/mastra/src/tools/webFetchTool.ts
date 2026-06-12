import { createTool } from "@mastra/core/tools";
import { z } from "zod";

export const webFetchTool = createTool({
  id: "webFetch",
  description: "Fetch and extract text content from a URL",
  inputSchema: z.object({
    url: z.string().url(),
    maxLength: z.number().default(10000),
  }),
  outputSchema: z.object({
    url: z.string(),
    content: z.string(),
    truncated: z.boolean(),
  }),
  execute: async ({ context }) => {
    const { url, maxLength } = context;
    const res = await fetch(url);
    const html = await res.text();
    const text = html
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return {
      url,
      content: text.slice(0, maxLength),
      truncated: text.length > maxLength,
    };
  },
});
