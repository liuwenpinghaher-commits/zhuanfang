import type { FastifyInstance } from "fastify";
import { dedupeGeneratedArtifacts } from "../../../../src/domain/lifecycle";
import type { ProductStateRepository } from "../product-state-repository";

export async function registerGeneratedArtifactRoutes(server: FastifyInstance, repository: ProductStateRepository) {
  server.post("/api/generated-artifacts/cleanup", async () => {
    const result = dedupeGeneratedArtifacts(repository.getState());
    repository.replaceState(result.nextState);
    return {
      removed: result.removed,
      state: result.nextState
    };
  });
}
