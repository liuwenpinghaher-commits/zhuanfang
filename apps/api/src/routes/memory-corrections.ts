import type { FastifyInstance } from "fastify";
import { markMemoryCorrection } from "../../../../zhuanfang/src/domain/engine";
import type { ProductState } from "../../../../zhuanfang/src/domain/types";
import type { ProductStateRepository } from "../product-state-repository";

interface CreateMemoryCorrectionPayload {
  text?: unknown;
}

export async function registerMemoryCorrectionRoutes(server: FastifyInstance, repository: ProductStateRepository) {
  server.post("/api/memory-corrections", async (request, reply) => {
    const state = repository.getState();
    const text = normalizeOptionalString(normalizeObject<CreateMemoryCorrectionPayload>(request.body).text);
    if (!text) {
      return reply.code(422).send({ error: "Memory correction text is required." });
    }

    const nextState = markMemoryCorrection(state, text);
    const correction = findCreatedCorrection(state, nextState);
    repository.replaceState(nextState);

    return { correction, state: nextState };
  });
}

function normalizeObject<T>(value: unknown): Partial<T> {
  return value && typeof value === "object" ? (value as Partial<T>) : {};
}

function normalizeOptionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function findCreatedCorrection(previousState: ProductState, nextState: ProductState) {
  return (
    nextState.memoryCorrections.find(
      (correction) => !previousState.memoryCorrections.some((previous) => previous.id === correction.id)
    ) ?? nextState.memoryCorrections[0]
  );
}
