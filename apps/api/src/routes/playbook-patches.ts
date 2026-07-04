import type { FastifyInstance } from "fastify";
import { approvePlaybookPatch, revertPlaybookPatch } from "../../../../src/domain/engine";
import type { PlaybookPatch, ProductState } from "../../../../src/domain/types";
import type { ProductStateRepository } from "../product-state-repository";

export async function registerPlaybookPatchRoutes(server: FastifyInstance, repository: ProductStateRepository) {
  server.post("/api/playbook-patches/:id/apply", async (request, reply) => {
    const state = repository.getState();
    const patch = findPatch(state, getPatchId(request.params));
    if (!patch) {
      return reply.code(404).send({ error: "PlaybookPatch not found." });
    }
    if (patch.status !== "proposed") {
      return reply.code(409).send({ error: "Only proposed PlaybookPatch records can be applied." });
    }

    const nextState = approvePlaybookPatch(state, patch.id);
    const appliedPatch = findPatch(nextState, patch.id);
    // state 必须是 replaceState 返回的权威态(revision 已 bump),否则客户端下一次乐观 PUT 必 409。
    const persisted = repository.replaceState(nextState);

    return { patch: appliedPatch, state: persisted };
  });

  server.post("/api/playbook-patches/:id/revert", async (request, reply) => {
    const state = repository.getState();
    const patch = findPatch(state, getPatchId(request.params));
    if (!patch) {
      return reply.code(404).send({ error: "PlaybookPatch not found." });
    }
    if (patch.status !== "applied") {
      return reply.code(422).send({ error: "Only applied PlaybookPatch records can be reverted." });
    }

    const nextState = revertPlaybookPatch(state, patch.id);
    const revertedPatch = findPatch(nextState, patch.id);
    const persisted = repository.replaceState(nextState);

    return { patch: revertedPatch, state: persisted };
  });
}

function normalizeObject<T>(value: unknown): Partial<T> {
  return value && typeof value === "object" ? (value as Partial<T>) : {};
}

function getPatchId(params: unknown) {
  return normalizeObject<{ id: string }>(params).id;
}

function findPatch(state: ProductState, patchId: unknown): PlaybookPatch | undefined {
  return typeof patchId === "string" ? state.playbookPatches.find((patch) => patch.id === patchId) : undefined;
}
