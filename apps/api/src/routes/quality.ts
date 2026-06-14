import type { FastifyInstance } from "fastify";
import type { ProductStateRepository } from "../product-state-repository";

// Inlined from removed packages/mastra/src/evals/scorers.ts — simple deterministic scorers, no Mastra dependency
const scorers = {
  interviewNaturalness: (transcript: string): { score: number; feedback: string } => {
    const questions = (transcript.match(/\?/g) || []).length;
    const turns = transcript.split("\n").filter((l) => l.trim()).length;
    const ratio = questions / Math.max(turns, 1);
    return {
      score: Math.min(ratio * 2, 1),
      feedback: ratio > 0.3 ? "Good question frequency" : "Consider asking more questions",
    };
  },

  followupRelevance: (transcript: string, previousTopics: string[]): { score: number; feedback: string } => {
    const lowerTranscript = transcript.toLowerCase();
    const matches = previousTopics.filter((t) => lowerTranscript.includes(t.toLowerCase()));
    const score = matches.length / Math.max(previousTopics.length, 1);
    return { score, feedback: score > 0.5 ? "Good topic continuity" : "Follow-ups could be more relevant" };
  },

  memoryCitation: (response: string, memories: string[]): { score: number; feedback: string } => {
    const hasCitation = memories.some((m) => response.includes(m.slice(0, 10)));
    return { score: hasCitation ? 0.9 : 0.3, feedback: hasCitation ? "Memory referenced" : "No memory citation found" };
  },

  memoryCandidatePrecision: (candidate: { text: string; evidenceQuote: string }): { score: number; feedback: string } => {
    const textWords = new Set(candidate.text.toLowerCase().split(/\s+/));
    const evidenceWords = new Set(candidate.evidenceQuote.toLowerCase().split(/\s+/));
    const overlap = [...textWords].filter((w) => evidenceWords.has(w)).length;
    const score = overlap / Math.max(textWords.size, 1);
    return { score, feedback: score > 0.3 ? "Good evidence alignment" : "Weak evidence support" };
  },

  sensitiveLeakage: (content: string): { score: number; feedback: string } => {
    const patterns = [/\b\d{11}\b/, /\b\d{18}\b/, /\b(password|secret|token|key)\b/i, /\b\d{16,19}\b/];
    const leaks = patterns.filter((p) => p.test(content));
    return { score: leaks.length === 0 ? 1 : 0, feedback: leaks.length === 0 ? "No sensitive data detected" : `Found ${leaks.length} potential leaks` };
  },

  contextPackRelevance: (pack: Record<string, unknown>, sessionTopic: string): { score: number; feedback: string } => {
    const packStr = JSON.stringify(pack).toLowerCase();
    const relevance = packStr.includes(sessionTopic.toLowerCase());
    return { score: relevance ? 0.8 : 0.3, feedback: relevance ? "Context pack relevant" : "Context pack may be off-topic" };
  },

  sourceFaithfulness: (claim: string, source: string): { score: number; feedback: string } => {
    const claimWords = claim.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
    const sourceLower = source.toLowerCase();
    const faithful = claimWords.filter((w) => sourceLower.includes(w)).length;
    const score = faithful / Math.max(claimWords.length, 1);
    return { score, feedback: score > 0.5 ? "Claims supported by source" : "Claims may deviate from source" };
  },

  interviewFeedback: (feedbacks: { rating: number }[]): { score: number; feedback: string } => {
    if (feedbacks.length === 0) return { score: 0, feedback: "No feedback collected" };
    const avg = feedbacks.reduce((sum, f) => sum + f.rating, 0) / feedbacks.length;
    return { score: avg / 5, feedback: `Average rating: ${avg.toFixed(1)}/5 from ${feedbacks.length} reviews` };
  },
} as const;

type ScorerName = keyof typeof scorers;

interface ScoreRequestBody {
  scorerName?: unknown;
  input?: unknown;
  reference?: unknown;
  previousTopics?: unknown;
  memories?: unknown;
  candidate?: unknown;
  pack?: unknown;
  sessionTopic?: unknown;
  claim?: unknown;
  source?: unknown;
  feedbacks?: unknown;
}

const SCORER_NAMES: ReadonlySet<ScorerName> = new Set([
  "interviewNaturalness",
  "followupRelevance",
  "memoryCitation",
  "memoryCandidatePrecision",
  "sensitiveLeakage",
  "contextPackRelevance",
  "sourceFaithfulness",
  "interviewFeedback"
]);

function isScorerName(value: unknown): value is ScorerName {
  return typeof value === "string" && SCORER_NAMES.has(value as ScorerName);
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function registerQualityRoutes(app: FastifyInstance, stateRepo: ProductStateRepository) {
  app.post("/api/quality/score", async (request, reply) => {
    const body = (request.body ?? {}) as ScoreRequestBody;
    if (!isScorerName(body.scorerName)) {
      return reply.code(400).send({
        error: `Unknown scorer. Expected one of: ${Array.from(SCORER_NAMES).join(", ")}`
      });
    }

    const scorerName = body.scorerName;

    switch (scorerName) {
      case "interviewNaturalness": {
        const result = scorers.interviewNaturalness(asString(body.input));
        return { scorerName, ...result };
      }
      case "followupRelevance": {
        const transcript = asString(body.input);
        const previousTopics = asStringArray(body.previousTopics);
        const result = scorers.followupRelevance(transcript, previousTopics);
        return { scorerName, ...result };
      }
      case "memoryCitation": {
        const response = asString(body.input);
        const memories = asStringArray(body.memories);
        const result = scorers.memoryCitation(response, memories);
        return { scorerName, ...result };
      }
      case "memoryCandidatePrecision": {
        const candidate = body.candidate as { text?: unknown; evidenceQuote?: unknown } | undefined;
        const result = scorers.memoryCandidatePrecision({
          text: asString(candidate?.text),
          evidenceQuote: asString(candidate?.evidenceQuote)
        });
        return { scorerName, ...result };
      }
      case "sensitiveLeakage": {
        const result = scorers.sensitiveLeakage(asString(body.input));
        return { scorerName, ...result };
      }
      case "contextPackRelevance": {
        const result = scorers.contextPackRelevance(body.pack ?? {}, asString(body.sessionTopic));
        return { scorerName, ...result };
      }
      case "sourceFaithfulness": {
        const result = scorers.sourceFaithfulness(asString(body.claim ?? body.input), asString(body.source ?? body.reference));
        return { scorerName, ...result };
      }
      case "interviewFeedback": {
        const feedbacks = Array.isArray(body.feedbacks)
          ? body.feedbacks.filter(
              (item): item is { rating: number } =>
                Boolean(item && typeof item === "object" && typeof (item as { rating?: unknown }).rating === "number")
            )
          : [];
        const result = scorers.interviewFeedback(feedbacks);
        return { scorerName, ...result };
      }
      default: {
        const exhaustiveCheck: never = scorerName;
        return reply.code(400).send({ error: `Unhandled scorer: ${String(exhaustiveCheck)}` });
      }
    }
  });

  app.get("/api/quality/scorers", async () => ({
    scorers: Array.from(SCORER_NAMES)
  }));

  app.get("/api/quality/report", async () => {
    const state = await stateRepo.getState();
    const auditCount = (state.auditEvents || []).length;
    const aiRunCount = (state.aiRunEvents || []).length;
    const sessionCount = state.sessions.length;
    const memoryCount = (state.memoryRecords || []).length;

    return {
      summary: {
        totalSessions: sessionCount,
        totalMemories: memoryCount,
        totalAuditEvents: auditCount,
        totalAiRuns: aiRunCount
      },
      recentAuditEvents: (state.auditEvents || []).slice(0, 20),
      recentAiRuns: (state.aiRunEvents || []).slice(0, 20)
    };
  });
}
