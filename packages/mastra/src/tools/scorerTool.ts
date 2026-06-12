import { createTool } from "@mastra/core/tools";
import { z } from "zod";

const scorers: Record<
  string,
  (input: string, ref?: string) => { score: number; reason: string }
> = {
  interviewNaturalness: (text) => ({
    score: text.includes("?") ? 0.8 : 0.5,
    reason: text.includes("?")
      ? "Contains follow-up questions"
      : "Missing questions",
  }),
  followupRelevance: (text, ref) => ({
    score:
      ref && text.toLowerCase().includes(ref.toLowerCase().slice(0, 10))
        ? 0.9
        : 0.4,
    reason: "Keyword overlap assessment",
  }),
  memoryCitation: (text) => {
    const hasQuote = text.includes('"') || text.includes("「");
    return {
      score: hasQuote ? 0.85 : 0.3,
      reason: hasQuote ? "Contains citations" : "No citations found",
    };
  },
  memoryCandidatePrecision: (text) => ({
    score: text.length > 20 ? 0.7 : 0.3,
    reason: text.length > 20 ? "Sufficient detail" : "Too brief",
  }),
  sensitiveLeakage: (text) => {
    const sensitive = /\b(password|secret|key|token)\b/i;
    return {
      score: sensitive.test(text) ? 0.1 : 1.0,
      reason: sensitive.test(text) ? "Sensitive content detected" : "Clean",
    };
  },
  contextPackRelevance: (text) => ({
    score: text.length > 100 ? 0.75 : 0.4,
    reason: "Content volume assessment",
  }),
  sourceFaithfulness: (text, ref) => ({
    score: ref ? 0.8 : 0.5,
    reason: ref ? "Has reference source" : "No reference source",
  }),
  interviewFeedback: (text) => ({
    score: text.length > 0 ? 0.7 : 0,
    reason: "Feedback present",
  }),
};

export const scorerTool = createTool({
  id: "scorer",
  description:
    "Score and evaluate AI outputs using 8 rule-based scorers for quality assessment",
  inputSchema: z.object({
    scorerName: z.enum([
      "interviewNaturalness",
      "followupRelevance",
      "memoryCitation",
      "memoryCandidatePrecision",
      "sensitiveLeakage",
      "contextPackRelevance",
      "sourceFaithfulness",
      "interviewFeedback",
    ]),
    input: z.string(),
    reference: z.string().optional(),
  }),
  outputSchema: z.object({
    scorerName: z.string(),
    score: z.number(),
    reason: z.string(),
  }),
  execute: async ({ context }) => {
    const { scorerName, input, reference } = context;
    const scorer = scorers[scorerName];
    if (!scorer) throw new Error(`Unknown scorer: ${scorerName}`);
    return { scorerName, ...scorer(input, reference) };
  },
});
