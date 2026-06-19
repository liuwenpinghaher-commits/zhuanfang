import type { FastifyInstance } from "fastify";
import { approveMemoryCandidate, rejectMemoryCandidate, updateMemoryCandidateText } from "../../../../src/domain/engine";
import type { MemoryCandidate, ProductState } from "../../../../src/domain/types";
import type { ProductStateRepository } from "../product-state-repository";
import type { BailianEmbeddingClient } from "../providers/bailian";

interface RejectMemoryCandidatePayload {
  reviewNote?: unknown;
}

interface UpdateMemoryCandidatePayload {
  text?: unknown;
}

interface MemoryCandidateRouteOptions {
  embeddingClient?: BailianEmbeddingClient;
}

export async function registerMemoryCandidateRoutes(
  server: FastifyInstance,
  repository: ProductStateRepository,
  options: MemoryCandidateRouteOptions = {}
) {
  server.patch("/api/memory-candidates/:id", async (request, reply) => {
    const state = repository.getState();
    const candidate = findCandidate(state, getCandidateId(request.params));
    if (!candidate) {
      return reply.code(404).send({ error: "Memory candidate not found." });
    }
    if (candidate.status !== "pending") {
      return reply.code(409).send({ error: "Memory candidate is not pending." });
    }

    const text = normalizeOptionalString(normalizeObject<UpdateMemoryCandidatePayload>(request.body).text);
    if (!text) {
      return reply.code(422).send({ error: "Memory candidate text is required." });
    }

    const nextState = updateMemoryCandidateText(state, candidate.id, text);
    const updatedCandidate = findCandidate(nextState, candidate.id);
    repository.replaceState(nextState);

    return { candidate: updatedCandidate, state: nextState };
  });

  server.post("/api/memory-candidates/:id/approve", async (request, reply) => {
    const state = repository.getState();
    const candidate = findCandidate(state, getCandidateId(request.params));
    if (!candidate) {
      return reply.code(404).send({ error: "Memory candidate not found." });
    }
    if (candidate.status !== "pending") {
      return reply.code(409).send({ error: "Memory candidate is not pending." });
    }

    // M3c: enrich the confirmed record with a semantic embedding so the long-term
    // store is cosine-searchable from the interview line. The embedding is computed
    // here (route layer has the client); the domain approve stays pure and offline-
    // safe. On any embed failure / no client we pass nothing and the record is
    // created without an embedding (keyword retrieval still works). importance is
    // backfilled inside approveMemoryCandidate from the candidate's reviewScore.
    const embedding = await embedCandidateText(candidate.text, options.embeddingClient);
    const nextState = approveMemoryCandidate(state, candidate.id, embedding ? { embedding } : {});
    const reviewedCandidate = findCandidate(nextState, candidate.id);
    const record = nextState.memoryRecords.find((item) => item.sourceCandidateId === candidate.id);
    repository.replaceState(nextState);

    return { candidate: reviewedCandidate, record, state: nextState };
  });

  server.post("/api/memory-candidates/:id/reject", async (request, reply) => {
    const state = repository.getState();
    const candidate = findCandidate(state, getCandidateId(request.params));
    if (!candidate) {
      return reply.code(404).send({ error: "Memory candidate not found." });
    }
    if (candidate.status !== "pending") {
      return reply.code(409).send({ error: "Memory candidate is not pending." });
    }

    const reviewNote = normalizeOptionalString(normalizeObject<RejectMemoryCandidatePayload>(request.body).reviewNote);
    const nextState = rejectMemoryCandidate(state, candidate.id, reviewNote);
    const reviewedCandidate = findCandidate(nextState, candidate.id);
    repository.replaceState(nextState);

    return { candidate: reviewedCandidate, state: nextState };
  });
}

// M3c: embed the candidate text for semantic recall. Fail-safe — returns undefined
// when there's no client, the call throws, or the model returns an empty vector, so
// approve always succeeds (it just degrades to keyword retrieval for that record).
async function embedCandidateText(
  text: string,
  embeddingClient: BailianEmbeddingClient | undefined
): Promise<number[] | undefined> {
  if (!embeddingClient) {
    return undefined;
  }
  try {
    const vectors = await embeddingClient.embed([text]);
    const vector = vectors[0];
    return Array.isArray(vector) && vector.length > 0 ? vector : undefined;
  } catch (error) {
    console.warn(
      JSON.stringify({ event: "memory_approve_embed_failed", error: error instanceof Error ? error.message : String(error) })
    );
    return undefined;
  }
}

function normalizeObject<T>(value: unknown): Partial<T> {
  return value && typeof value === "object" ? (value as Partial<T>) : {};
}

function normalizeOptionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function getCandidateId(params: unknown) {
  return normalizeObject<{ id: string }>(params).id;
}

function findCandidate(state: ProductState, candidateId: unknown): MemoryCandidate | undefined {
  return typeof candidateId === "string"
    ? state.memoryCandidates.find((candidate) => candidate.id === candidateId)
    : undefined;
}
