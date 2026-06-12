import { createTool } from "@mastra/core/tools";
import { z } from "zod";

export const documentParseTool = createTool({
  id: "documentParse",
  description:
    "Parse documents (markdown, html, text) into structured paragraphs",
  inputSchema: z.object({
    content: z.string(),
    format: z.enum(["markdown", "html", "text"]).default("text"),
  }),
  outputSchema: z.object({
    format: z.string(),
    paragraphCount: z.number(),
    totalLength: z.number(),
    paragraphs: z.array(z.string()),
  }),
  execute: async ({ context }) => {
    const { content, format } = context;
    let text = content;
    if (format === "html") {
      text = content
        .replace(/<[^>]*>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    }
    const paragraphs = text
      .split(/\n\s*\n/)
      .filter((p) => p.trim().length > 0);
    return {
      format,
      paragraphCount: paragraphs.length,
      totalLength: text.length,
      paragraphs: paragraphs.slice(0, 50),
    };
  },
});
