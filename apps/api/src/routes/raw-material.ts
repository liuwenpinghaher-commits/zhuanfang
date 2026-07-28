import type { FastifyInstance } from "fastify";
import type { InterviewRawMaterial, ProductState } from "../../../../src/domain/types";
import { backfillEvidenceAnchors } from "../../../../src/domain/raw-material";
import type { RawMaterialRepository } from "../raw-material-repository";
import type { ProductStateRepository } from "../product-state-repository";
import { replaceStateDurable } from "../product-state-repository";

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
  rawRepo: RawMaterialRepository,
  productRepo: ProductStateRepository
): Promise<void> {
  server.get("/api/sessions/:id/raw-material", async (request, reply) => {
    const id = (request.params as { id?: string }).id ?? "";
    const material = await rawRepo.get(id);   // R2a:仓库接口已异步化
    if (!material) {
      return reply.code(404).send({ error: "Raw material not found for session." });
    }
    return material;
  });

  /**
   * One-shot migration: bring the existing store up to the cold-storage layout.
   * 1. Backfill evidence anchors on memory records/candidates while turns are
   *    still hot (must run BEFORE offloading, which strips the turns).
   * 2. Offload every completed session not yet flagged `rawMaterialOffloaded`:
   *    its turns/strategyTrace move to cold storage (rawRepo) and the hot state
   *    keeps only the summary/card/guide.
   * Idempotent: already-offloaded sessions are skipped; re-running is a no-op
   * for them and re-stamping anchors leaves stamped items untouched.
   */
  server.post("/api/admin/offload-completed", async () => {
    let hotState = backfillEvidenceAnchors(productRepo.getState());
    const targets = hotState.sessions.filter(
      (s) => s.status === "completed" && !s.rawMaterialOffloaded
    );
    let offloaded = 0;
    for (const session of targets) {
      const { hotState: next, material } = offloadCompletedSession(hotState, session.id);
      hotState = next;
      if (material) {
        await rawRepo.put(material);   // R2a:仓库接口已异步化
        offloaded += 1;
      }
    }
    await replaceStateDurable(productRepo, hotState);
    return { offloaded };
  });
}
