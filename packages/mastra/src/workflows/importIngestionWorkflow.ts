import { createStep, Workflow } from "@mastra/core/workflows";
import { z } from "zod";

const classifyImportStep = new createStep({
  id: "classifyImport",
  description: "Classify the import type and extract metadata",
  inputSchema: z.object({
    importUrl: z.string(),
    rawContent: z.string().optional(),
  }),
  outputSchema: z.object({
    classification: z.any(),
  }),
  execute: async ({ inputData }) => {
    const url = inputData.importUrl.toLowerCase();
    let importType = "document";
    if (url.includes("interview") || url.includes("transcript")) {
      importType = "interview_transcript";
    } else if (url.includes("audio") || url.includes(".mp3") || url.includes(".wav")) {
      importType = "audio";
    } else if (url.includes("reference")) {
      importType = "reference_interview";
    }
    return {
      classification: {
        importType,
        confidence: 0.9,
        metadata: {
          source: inputData.importUrl,
          detectedFormat: importType === "audio" ? "audio/mpeg" : "text/plain",
          estimatedSize: inputData.rawContent?.length || 0,
        },
        suggestedWorkflow:
          importType === "audio"
            ? "audioTranscription"
            : importType === "reference_interview"
              ? "referenceInterviewLearning"
              : "documentIngestion",
      },
    };
  },
});

const cleanTranscriptStep = new createStep({
  id: "cleanTranscript",
  description: "Clean and normalize interview transcript",
  inputSchema: z.object({
    transcript: z.string(),
    classification: z.any(),
  }),
  outputSchema: z.object({
    cleanedTranscript: z.any(),
  }),
  execute: async ({ inputData }) => {
    const cleaned = inputData.transcript
      .replace(/\s+/g, " ")
      .replace(/\[inaudible\]/gi, "[unclear]")
      .trim();
    return {
      cleanedTranscript: {
        original: inputData.transcript,
        cleaned,
        wordCount: cleaned.split(/\s+/).length,
        changes: {
          whitespaceNormalized: true,
          tagsNormalized: true,
        },
      },
    };
  },
});

const parseDocumentStep = new createStep({
  id: "parseDocument",
  description: "Parse document into structured paragraphs",
  inputSchema: z.object({
    content: z.string(),
    format: z.enum(["markdown", "html", "text"]).default("text"),
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
        format: inputData.format,
        paragraphCount: paragraphs.length,
        totalLength: text.length,
        paragraphs: paragraphs.slice(0, 50),
      },
    };
  },
});

export const importIngestionWorkflow = new Workflow({
  id: "import-ingestion",
  description: "Classifies import, cleans transcript, and parses document",
  inputSchema: z.object({
    importUrl: z.string(),
    rawContent: z.string().optional(),
    transcript: z.string().optional(),
    format: z.enum(["markdown", "html", "text"]).default("text"),
  }),
  outputSchema: z.object({
    classification: z.any(),
    cleanedTranscript: z.any().optional(),
    parsedDocument: z.any().optional(),
  }),
})
  .then(classifyImportStep)
  .then(cleanTranscriptStep)
  .then(parseDocumentStep)
  .commit();
