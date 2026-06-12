import type { FastifyInstance } from "fastify";

export async function registerHealthRoutes(server: FastifyInstance) {
  server.get("/api/health", async () => ({
    ok: true,
    service: "interview-product-api"
  }));
}
