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
        console.warn(JSON.stringify({ event: "llm_fallback", capability: "reviews", error: error instanceof Error ? error.message : String(error) }));
      }
    }
    return buildDeterministicReviews(state);
  });
}
