import type { FastifyInstance } from "fastify";
import { deleteMemoryRecord, deprecateMemoryRecord, updateMemoryRecordText } from "../../../../zhuanfang/src/domain/engine";
import type { MemoryRecord, ProductState } from "../../../../zhuanfang/src/domain/types";
import type { ProductStateRepository } from "../product-state-repository";

interface DeprecateMemoryRecordPayload {
  reason?: unknown;
}

interface UpdateMemoryRecordPayload {
  text?: unknown;
}

export async function registerMemoryRecordRoutes(server: FastifyInstance, repository: ProductStateRepository) {
  server.patch("/api/memory-records/:id", async (request, reply) => {
    const state = repository.getState();
    const record = findRecord(state, getRecordId(request.params));
    if (!record) {
      return reply.code(404).send({ error: "Memory record not found." });
    }
    if (record.status !== "confirmed") {
      return reply.code(409).send({ error: "Memory record is not confirmed." });
    }

    const text = normalizeOptionalString(normalizeObject<UpdateMemoryRecordPayload>(request.body).text);
    if (!text) {
      return reply.code(422).send({ error: "Memory record text is required." });
    }

    const nextState = updateMemoryRecordText(state, record.id, text);
    const updatedRecord = findRecord(nextState, record.id);
    repository.replaceState(nextState);

    return { record: updatedRecord, state: nextState };
  });

  server.delete("/api/memory-records/:id", async (request, reply) => {
    const state = repository.getState();
    const record = findRecord(state, getRecordId(request.params));
    if (!record) {
      return reply.code(404).send({ error: "Memory record not found." });
    }

    const nextState = deleteMemoryRecord(state, record.id);
    repository.replaceState(nextState);

    return { record, state: nextState };
  });

  server.post("/api/memory-records/:id/deprecate", async (request, reply) => {
    const state = repository.getState();
    const record = findRecord(state, getRecordId(request.params));
    if (!record) {
      return reply.code(404).send({ error: "Memory record not found." });
    }
    if (record.status !== "confirmed") {
      return reply.code(409).send({ error: "Memory record is not confirmed." });
    }

    const reason = normalizeOptionalString(normalizeObject<DeprecateMemoryRecordPayload>(request.body).reason);
    const nextState = deprecateMemoryRecord(state, record.id, reason);
    const deprecatedRecord = findRecord(nextState, record.id);
    repository.replaceState(nextState);

    return { record: deprecatedRecord, state: nextState };
  });
}

function normalizeObject<T>(value: unknown): Partial<T> {
  return value && typeof value === "object" ? (value as Partial<T>) : {};
}

function normalizeOptionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function getRecordId(params: unknown) {
  return normalizeObject<{ id: string }>(params).id;
}

function findRecord(state: ProductState, recordId: unknown): MemoryRecord | undefined {
  return typeof recordId === "string" ? state.memoryRecords.find((record) => record.id === recordId) : undefined;
}
