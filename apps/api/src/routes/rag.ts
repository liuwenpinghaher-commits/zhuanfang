import type { FastifyInstance } from "fastify";
import { buildSemanticRagContext } from "../../../../src/domain/context-pack";
import { createLlmBudget, type LlmBudget } from "../llm-budget";
import type { BailianChatClient, BailianEmbeddingClient } from "../providers/bailian";
import type { ProductStateRepository } from "../product-state-repository";

const TOP_K = 5;

export interface RagCitation {
  id: string;
  title: string;
  sourceUrl?: string;
}

export interface RagQueryResponse {
  answer: string;
  citations: RagCitation[];
}

interface RagRouteOptions {
  embeddingClient?: BailianEmbeddingClient;
  bailianChatClient?: BailianChatClient;
  llmBudget?: LlmBudget;
}

export async function registerRagRoutes(
  server: FastifyInstance,
  repository: ProductStateRepository,
  options: RagRouteOptions = {}
) {
  const budget = options.llmBudget ?? createLlmBudget();

  server.post("/api/rag/query", async (request, reply) => {
    const payload = request.body && typeof request.body === "object"
      ? (request.body as Record<string, unknown>)
      : {};

    const question = typeof payload.question === "string" ? payload.question.trim() : "";
    if (!question) {
      return reply.code(422).send({ error: "question 字段不能为空。" });
    }

    const state = repository.getState();

    // ── 无任何 ragChunks 快速退出 ──
    if (state.ragChunks.length === 0) {
      return reply.send({
        answer: "暂无相关资料，请先导入参考文献后再提问。",
        citations: []
      } satisfies RagQueryResponse);
    }

    // ── 召回 ──
    let queryEmbedding: number[] | undefined;
    if (options.embeddingClient) {
      try {
        const vecs = await options.embeddingClient.embed([question]);
        queryEmbedding = vecs[0];
      } catch (err) {
        console.warn(
          JSON.stringify({ event: "rag_embed_failed", error: err instanceof Error ? err.message : String(err) })
        );
      }
    }

    // buildSemanticRagContext handles both cosine (when queryEmbedding present)
    // and keyword fallback paths in a single call.
    const ragContext = buildSemanticRagContext(state, question, TOP_K, queryEmbedding);
    const chunks = ragContext.chunks;

    const citations: RagCitation[] = chunks.map((c) => ({
      id: c.id,
      title: c.title,
      ...(c.sourceUrl ? { sourceUrl: c.sourceUrl } : {})
    }));

    // ── 答案生成 ──
    const allowLlm = !!options.bailianChatClient && budget.tryConsume("rag_query");
    if (!!options.bailianChatClient && !allowLlm) {
      console.warn(JSON.stringify({ event: "llm_budget_exceeded", capability: "rag_query" }));
    }

    let answer: string;

    if (chunks.length === 0) {
      answer = "暂无相关资料，请先导入参考文献后再提问。";
    } else if (allowLlm) {
      // LLM path: build context from top chunks and generate answer
      const contextText = chunks
        .map((c, i) => `[${i + 1}] 《${c.title}》：${c.text}`)
        .join("\n\n");

      const systemPrompt =
        "你是一位专业的资料问答助手。根据以下参考资料回答用户的问题，回答需准确引用资料内容，保持简洁专业。如果资料不足以回答问题，请如实说明。";
      const userPrompt = `参考资料：\n${contextText}\n\n问题：${question}`;

      try {
        answer = await options.bailianChatClient!.complete({
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt }
          ]
        });
      } catch (err) {
        console.warn(
          JSON.stringify({ event: "rag_llm_failed", error: err instanceof Error ? err.message : String(err) })
        );
        // Fallback on LLM error
        answer = buildFallbackAnswer(question, chunks);
      }
    } else {
      // Deterministic fallback: concatenate chunk title + snippet
      answer = buildFallbackAnswer(question, chunks);
    }

    return reply.send({ answer, citations } satisfies RagQueryResponse);
  });
}

/** Deterministic answer when no LLM is available: stitch retrieved chunk summaries. */
function buildFallbackAnswer(
  question: string,
  chunks: Array<{ title: string; text: string }>
): string {
  if (chunks.length === 0) {
    return "暂无相关资料，请先导入参考文献后再提问。";
  }
  const parts = chunks.slice(0, 3).map((c) => `《${c.title}》：${c.text.slice(0, 120)}`);
  return `关于"${question}"，根据已导入资料整理如下：\n\n${parts.join("\n\n")}`;
}
