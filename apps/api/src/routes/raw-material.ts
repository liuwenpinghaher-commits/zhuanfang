import type { FastifyInstance } from "fastify";
import type { InterviewRawMaterial, ProductState } from "../../../../src/domain/types";
import type { RawMaterialRepository } from "../raw-material-repository";

/**
 * Offload a completed interview session's heavy evidence (turns + strategyTrace)
 * into a cold-storage payload, returning a "hot" state where that session keeps
 * only its summary/card/guide and is flagged `rawMaterialOffloaded`. The hot
 * state stays small; the raw material is served lazily via the endpoint below.
 *
 * Unknown sessionId → no material and the original state is returned untouched.
 */
export function offloadCompletedSession(
  state: ProductState,
  sessionId: string
): { hotState: ProductState; material?: InterviewRawMaterial } {
  const session = state.sessions.find((s) => s.id === sessionId);
  if (!session) {
    return { hotState: state };
  }
  const material: InterviewRawMaterial = {
    sessionId,
    turns: session.turns,
    strategyTrace: session.strategyTrace ?? [],
    createdAt: session.completedAt ?? session.startedAt
  };
  const hotState: ProductState = {
    ...state,
    sessions: state.sessions.map((s) =>
      s.id === sessionId ? { ...s, turns: [], strategyTrace: [], rawMaterialOffloaded: true } : s
    )
  };
  return { hotState, material };
}

export async function registerRawMaterialRoutes(
  server: FastifyInstance,
  rawRepo: RawMaterialRepository
): Promise<void> {
  server.get("/api/sessions/:id/raw-material", async (request, reply) => {
    const id = (request.params as { id?: string }).id ?? "";
    const material = rawRepo.get(id);
    if (!material) {
      return reply.code(404).send({ error: "Raw material not found for session." });
    }
    return material;
  });
}
