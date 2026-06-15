import type { FastifyInstance } from "fastify";
import { buildDeterministicReviews, buildReviewsWithLlm } from "../intelligence/review-llm";
import type { ProductStateRepository } from "../product-state-repository";
import type { BailianChatClient } from "../providers/bailian";

interface ReviewRouteOptions {
  bailianChatClient?: BailianChatClient;
}

export async function registerReviewRoutes(
  server: FastifyInstance,
  repository: ProductStateRepository,
  options: ReviewRouteOptions = {}
) {
  server.get("/api/reviews", async () => {
    const state = repository.getState();
    if (options.bailianChatClient) {
      try {
        return await buildReviewsWithLlm(state, options.bailianChatClient);
      } catch (error) {
        console.warn("[reviews] LLM synthesis failed, falling back to deterministic:", error instanceof Error ? error.message : error);
      }
    }
    return buildDeterministicReviews(state);
  });
}
