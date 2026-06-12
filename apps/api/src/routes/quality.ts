import type { FastifyInstance } from "fastify";
import type { ProductStateRepository } from "../product-state-repository";

export function registerQualityRoutes(app: FastifyInstance, stateRepo: ProductStateRepository) {
  app.post("/api/quality/score", async (request) => {
    const { scorerName, input, reference } = request.body as {
      scorerName: string;
      input: string;
      reference?: string;
    };

    const rules: Record<string, (input: string, ref?: string) => { score: number; feedback: string }> = {
      sensitiveLeakage: (text) => {
        const patterns = [/\b\d{11}\b/, /\b\d{18}\b/, /\b(password|secret|token|key)\b/i];
        const leaks = patterns.filter((p) => p.test(text));
        return { score: leaks.length === 0 ? 1 : 0, feedback: leaks.length === 0 ? "Clean" : `${leaks.length} potential leaks` };
      },
      interviewNaturalness: (text) => {
        const questions = (text.match(/\?/g) || []).length;
        return { score: Math.min(questions / 5, 1), feedback: `${questions} questions found` };
      },
      memoryCandidatePrecision: (text, ref) => {
        if (!ref) return { score: 0.5, feedback: "No reference" };
        const overlap = text.split(/\s+/).filter((w) => ref.includes(w)).length;
        return { score: Math.min(overlap / 5, 1), feedback: `${overlap} overlapping words` };
      },
    };

    const scorer = rules[scorerName];
    if (!scorer) return { error: `Unknown scorer: ${scorerName}` };

    return { scorerName, ...scorer(input, reference) };
  });

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
        totalAiRuns: aiRunCount,
      },
      recentAuditEvents: (state.auditEvents || []).slice(0, 20),
      recentAiRuns: (state.aiRunEvents || []).slice(0, 20),
    };
  });
}
