import type { FastifyInstance } from "fastify";
import { normalizeProductState } from "../../../../src/domain/storage";
import type { ProductStateRepository } from "../product-state-repository";

export async function registerStateRoutes(server: FastifyInstance, repository: ProductStateRepository) {
  server.get("/api/state", async () => repository.getState());
  server.put("/api/state", async (request) => repository.replaceState(normalizeProductState(request.body)));
  server.post("/api/state/reset", async () => repository.resetState());
}
