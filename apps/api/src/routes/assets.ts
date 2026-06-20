import type { FastifyInstance } from "fastify";
import { confirmDecisionCandidate } from "../../../../src/domain/engine";
import type { DecisionAsset, ProductState } from "../../../../src/domain/types";
import type { ProductStateRepository } from "../product-state-repository";

// ponytail: this file used to expose PATCH status routes for points/questions/debts
// and decision review status, but the app is local-first — the frontend mutates
// ProductState with pure reducers and persists via the debounced PUT /api/state.
// Those routes were never called and were deleted to kill the dead/parallel write
// path. Only "confirm decision" stays on the server because it carries authority
// semantics and is the one asset write the frontend actually routes through.
export async function registerAssetRoutes(server: FastifyInstance, repository: ProductStateRepository) {
  server.post("/api/assets/decisions/:id/confirm", async (request, reply) => {
    const state = repository.getState();
    const decisionId = getRouteId(request.params);
    const decision = findDecision(state, decisionId);
    if (!decision) {
      return reply.code(404).send({ error: "Decision asset not found." });
    }
    if (decision.confirmationStatus !== "待用户确认") {
      return reply.code(409).send({ error: "Decision asset is already confirmed." });
    }

    const nextState = confirmDecisionCandidate(state, decision.id);
    const updatedDecision = findDecision(nextState, decision.id);
    if (!updatedDecision || updatedDecision.confirmationStatus !== "用户确认") {
      return reply.code(500).send({ error: "Decision asset was not confirmed." });
    }

    repository.replaceState(nextState);
    return { asset: updatedDecision, state: nextState };
  });
}

function normalizeObject<T>(value: unknown): Partial<T> {
  return value && typeof value === "object" ? (value as Partial<T>) : {};
}

function getRouteId(params: unknown) {
  return normalizeObject<{ id: string }>(params).id;
}

function findDecision(state: ProductState, decisionId: unknown): DecisionAsset | undefined {
  return typeof decisionId === "string" ? state.decisions.find((decision) => decision.id === decisionId) : undefined;
}
