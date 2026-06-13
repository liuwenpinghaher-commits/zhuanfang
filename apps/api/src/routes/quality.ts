import type { FastifyInstance } from "fastify";
import { scorers } from "../../../../packages/mastra/src/evals/scorers";
import type { ProductStateRepository } from "../product-state-repository";

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
