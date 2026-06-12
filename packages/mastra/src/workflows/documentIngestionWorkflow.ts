import { createStep, Workflow } from "@mastra/core/workflows";
import { z } from "zod";

const parseDocumentStep = new createStep({
  id: "parseDocument",
  description: "Parse document into structured paragraphs",
  inputSchema: z.object({
    content: z.string(),
    format: z.enum(["markdown", "html", "text"]).default("text"),
    title: z.string().optional(),
  }),
  outputSchema: z.object({
    parsedDocument: z.any(),
  }),
  execute: async ({ inputData }) => {
    let text = inputData.content;
    if (inputData.format === "html") {
      text = text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    }
    const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim().length > 0);
    return {
      parsedDocument: {
        title: inputData.title || "Untitled Document",
        format: inputData.format,
        paragraphCount: paragraphs.length,
        totalLength: text.length,
        paragraphs: paragraphs.slice(0, 50),
      },
    };
  },
});

const chunkAndStoreStep = new createStep({
  id: "chunkAndStore",
  description: "Chunk parsed document and store for RAG retrieval",
  inputSchema: z.object({
    parsedDocument: z.any(),
  }),
  outputSchema: z.object({
    storageResult: z.any(),
  }),
  execute: async ({ inputData }) => {
    const paragraphs = inputData.parsedDocument.paragraphs || [];
    const chunks = paragraphs.map((p: string, i: number) => ({
      id: `chunk_${String(i + 1).padStart(3, "0")}`,
      content: p,
      sourceType: "document",
      sourceId: inputData.parsedDocument.title,
      metadata: {
        paragraphIndex: i,
        charCount: p.length,
        storedAt: new Date().toISOString(),
      },
    }));
    return {
      storageResult: {
        chunksStored: chunks.length,
        totalChars: chunks.reduce((sum: number, c: any) => sum + c.metadata.charCount, 0),
        sourceId: inputData.parsedDocument.title,
        status: "success",
      },
    };
  },
});

export const documentIngestionWorkflow = new Workflow({
  id: "document-ingestion",
  description: "Parses document then chunks and stores for RAG retrieval",
  inputSchema: z.object({
    content: z.string(),
    format: z.enum(["markdown", "html", "text"]).default("text"),
    title: z.string().optional(),
  }),
  outputSchema: z.object({
    storageResult: z.any(),
  }),
})
  .then(parseDocumentStep)
  .then(chunkAndStoreStep)
  .commit();
