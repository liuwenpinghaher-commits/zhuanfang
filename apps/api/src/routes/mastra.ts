import type { FastifyInstance } from "fastify";
import { createMastraIntegration } from "../mastra-integration";
import type { ProductStateRepository } from "../product-state-repository";

export async function registerMastraRoutes(server: FastifyInstance, stateRepo: ProductStateRepository) {
  const mastra = createMastraIntegration(stateRepo);

  server.get("/api/mastra/agents", async () => {
    return { agents: mastra.getAgentNames() };
  });

  server.get("/api/mastra/workflows", async () => {
    return { workflows: mastra.getWorkflowNames() };
  });

  server.post("/api/mastra/workflows/:name/run", async (request) => {
    const { name } = request.params as { name: string };
    const body = (request.body as Record<string, unknown>) || {};
    const result = await mastra.runWorkflow(name, body);
    return result;
  });
}
