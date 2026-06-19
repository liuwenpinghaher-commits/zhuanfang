import type { FastifyInstance } from "fastify";
import { buildBackupRestoreRehearsalReport } from "../../../../src/domain/backup";
import { buildPrivacyReport, createPurgedProductState } from "../../../../src/domain/privacy";
import { normalizeProductState } from "../../../../src/domain/storage";
import type { ProductStateRepository } from "../product-state-repository";

export async function registerStateRoutes(server: FastifyInstance, repository: ProductStateRepository) {
  server.get("/api/state", async () => repository.getState());
  server.put("/api/state", async (request, reply) => {
    const stored = repository.getState();
    const incomingRevision = (request.body as { revision?: unknown })?.revision;
    // Require revision field to be present and exactly equal to stored.
    // Absent revision is treated as a conflict (409) to prevent zero-cost optimistic-lock bypass.
    if (typeof incomingRevision !== "number" || incomingRevision !== stored.revision) {
      return reply.code(409).send({ error: "stale revision", current: stored });
    }
    return repository.replaceState(normalizeProductState(request.body));
  });
  server.post("/api/state/reset", async () => repository.resetState());

  // P0-1: Privacy report
  server.get("/api/state/privacy-report", async () => {
    const state = repository.getState();
    return buildPrivacyReport(state);
  });

  // P0-2: Export (backup rehearsal report)
  server.get("/api/state/export", async () => {
    const state = repository.getState();
    return buildBackupRestoreRehearsalReport(state);
  });

  // P0-3: Purge
  server.post("/api/state/purge", async () => {
    const state = repository.getState();
    const purged = createPurgedProductState(state);
    return repository.replaceState(purged);
  });
}
