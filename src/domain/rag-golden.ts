/**
 * Stage-3 deterministic RAG golden evaluation (no LLM judge).
 * hit@k + refuse correctness against expected source ids.
 */
import type { KnowledgeChunk } from "./types";
import { retrievePersonalKnowledge } from "./retrieval";

export interface RagGoldenCase {
  id: string;
  query: string;
  /** Expected knowledge sourceIds (not chunk ids). */
  expectedSourceIds: string[];
  /** When true, system should reject grounding (empty/low score). */
  shouldRefuse: boolean;
  k?: number;
}

export interface RagGoldenScore {
  caseId: string;
  hitAtK: boolean;
  refused: boolean;
  refuseCorrect: boolean;
  topSourceIds: string[];
  topScore: number;
}

export function scoreRagGoldenCase(
  chunks: KnowledgeChunk[],
  golden: RagGoldenCase
): RagGoldenScore {
  const k = golden.k ?? 5;
  const result = retrievePersonalKnowledge(chunks, golden.query, { topK: k, minScore: 0.08 });
  const topSourceIds = result.chunks.map((c) => c.sourceId);
  const hitAtK =
    golden.expectedSourceIds.length === 0
      ? result.rejected
      : golden.expectedSourceIds.some((id) => topSourceIds.includes(id));
  const refuseCorrect = golden.shouldRefuse ? result.rejected : !result.rejected || hitAtK;
  return {
    caseId: golden.id,
    hitAtK: golden.shouldRefuse ? result.rejected : hitAtK,
    refused: result.rejected,
    refuseCorrect,
    topSourceIds,
    topScore: result.topScore
  };
}

export function summarizeRagGolden(scores: RagGoldenScore[]) {
  const n = scores.length || 1;
  const hits = scores.filter((s) => s.hitAtK).length;
  const refuseOk = scores.filter((s) => s.refuseCorrect).length;
  return {
    cases: scores.length,
    hitAtKRate: hits / n,
    refuseCorrectRate: refuseOk / n
  };
}
