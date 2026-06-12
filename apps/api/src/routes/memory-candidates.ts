import type { FastifyInstance } from "fastify";
import { approveMemoryCandidate, rejectMemoryCandidate, updateMemoryCandidateText } from "../../../../src/domain/engine";
import type { MemoryCandidate, ProductState } from "../../../../src/domain/types";
import type { ProductStateRepository } from "../product-state-repository";

interface RejectMemoryCandidatePayload {
  reviewNote?: unknown;
}

interface UpdateMemoryCandidatePayload {
  text?: unknown;
}

export async function registerMemoryCandidateRoutes(server: FastifyInstance, repository: ProductStateRepository) {
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

    const nextState = approveMemoryCandidate(state, candidate.id);
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
