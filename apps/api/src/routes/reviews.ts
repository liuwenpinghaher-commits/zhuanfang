import type { FastifyInstance } from "fastify";
import { buildReviewsWithLlm } from "../intelligence/review-llm";
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

  // 复盘是 LLM 能力：不可用就如实暴露（503/429/502），绝不用确定性模板冒充 LLM 洞察。
  server.get("/api/reviews", async (_request, reply) => {
    const state = repository.getState();
    if (!options.bailianChatClient) {
      return reply.code(503).send({ error: "复盘 LLM 未配置（缺少 DASHSCOPE_API_KEY），复盘功能不可用。" });
    }
    // RV-P1-01: isolate reviews budget from system (corpus/import/podcast) so opening
    // 复盘 cannot starve unrelated capabilities and vice versa.
    if (!budget.tryConsume("reviews")) {
      console.warn(JSON.stringify({ event: "llm_budget_exceeded", capability: "reviews" }));
      return reply.code(429).send({ error: "本时段复盘 LLM 预算已用尽，请稍后重试。" });
    }
    try {
      return await buildReviewsWithLlm(state, options.bailianChatClient);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(JSON.stringify({ event: "llm_failed", capability: "reviews", error: message }));
      return reply.code(502).send({ error: `复盘生成失败：${message}` });
    }
  });
}
