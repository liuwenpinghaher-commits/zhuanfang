import type { FastifyInstance } from "fastify";
import { buildDeterministicReviews, buildReviewsWithLlm } from "../intelligence/review-llm";
import { createLlmBudget, type LlmBudget } from "../llm-budget";
import type { ProductStateRepository } from "../product-state-repository";
import type { BailianChatClient } from "../providers/bailian";

interface ReviewRouteOptions {
  bailianChatClient?: BailianChatClient;
  llmBudget?: LlmBudget;
}

export async function registerReviewRoutes(
  server: FastifyInstance,
  repository: ProductStateRepository,
  options: ReviewRouteOptions = {}
) {
  const budget = options.llmBudget ?? createLlmBudget();

  server.get("/api/reviews", async () => {
    const state = repository.getState();
    const allowLlm = !!options.bailianChatClient && budget.tryConsume("system");
    if (!!options.bailianChatClient && !allowLlm) {
      console.warn(JSON.stringify({ event: "llm_budget_exceeded", capability: "reviews" }));
    }
    if (allowLlm) {
      try {
        return await buildReviewsWithLlm(state, options.bailianChatClient!);
      } catch (error) {
        console.warn(JSON.stringify({ event: "llm_fallback", capability: "reviews", error: error instanceof Error ? error.message : String(error) }));
      }
    }
    return buildDeterministicReviews(state);
  });
}
