import type { FastifyInstance } from "fastify";
import { buildSemanticRagContext, buildSemanticRagContextFromRecall } from "../../../../src/domain/context-pack";
import { sanitizeExternalMaterialText } from "../../../../src/domain/engine";
import { createLlmBudget, type LlmBudget } from "../llm-budget";
import type { BailianChatClient, BailianEmbeddingClient } from "../providers/bailian";
import type { ProductStateRepository } from "../product-state-repository";
import type { RagChunk } from "../../../../src/domain/types";
import { asNativeRecall } from "../recall/native-recall-capability";

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

  // 端点定位(审计说明):专供【导入资料问答】——只检索 state.ragChunks(用户导入的参考文献),
  // 独立于 /api/chat(后者是全局助手,召回八源知识索引含记忆/资产/主题/逐字稿)。当前前端主问答
  // 走 /api/chat(覆盖面更全),本端点保留作纯资料 QA 的 API(可被外部集成/未来"就资料提问"UI 调用),
  // 且是 native rag 混合召回(recallRagChunks,HNSW+BM25+rrf)在 HTTP 层的唯一出口。非死代码。
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

    // 方案一:surreal 权威档位优先走原生混合检索(HNSW+BM25+search::rrf,rag_ft/rag_emb 索引);
    // 无 embedding 时原生仍可 BM25-only(question 作 queryText,补关键词/专名召回)。命中后由域层
    // buildSemanticRagContextFromRecall 以与现状完全同口径重验 usage/来源 policy 门控并截断。
    // fail-safe:无原生能力 / 抛错 / 命中为空 → 回落域层 buildSemanticRagContext,行为与此前一致。
    let chunks: RagChunk[] = [];
    const nativeRecall = asNativeRecall(repository);
    if (nativeRecall && typeof nativeRecall.recallRagChunks === "function") {
      try {
        const hits = await nativeRecall.recallRagChunks({
          ...(queryEmbedding ? { embedding: queryEmbedding } : {}),
          queryText: question,
          k: TOP_K * 2,
          usage: "interview-context"
        });
        chunks = buildSemanticRagContextFromRecall(state, hits, TOP_K).chunks;
      } catch (err) {
        console.warn(
          JSON.stringify({ event: "rag_native_recall_degraded", error: err instanceof Error ? err.message : String(err) })
        );
      }
    }
    if (chunks.length === 0) {
      // buildSemanticRagContext handles both cosine (when queryEmbedding present)
      // and keyword fallback paths in a single call.
      chunks = buildSemanticRagContext(state, question, TOP_K, queryEmbedding).chunks;
    }

    // ── 答案生成 ──
    const allowLlm = !!options.bailianChatClient && budget.tryConsume("rag_query");
    if (!!options.bailianChatClient && !allowLlm) {
      console.warn(JSON.stringify({ event: "llm_budget_exceeded", capability: "rag_query" }));
    }

    let answer: string;
    // answeredChunks 记录实际参与生成答案的 chunk，citations 与之严格对齐
    let answeredChunks: RagChunk[];

    if (chunks.length === 0) {
      answer = "暂无相关资料，请先导入参考文献后再提问。";
      answeredChunks = [];
    } else if (allowLlm) {
      // LLM path: build context from ALL top-k chunks and generate answer
      answeredChunks = chunks;
      // 导入资料属外部不可信文本，拼进 prompt 前必须清洗，防注入（与 /api/chat 的 buildChatPrompt 对齐）。
      const contextText = chunks
        .map((c, i) => {
          const safeTitle = sanitizeExternalMaterialText(c.title, "资料");
          const safeText = sanitizeExternalMaterialText(c.text, "(内容已清洗)");
          return `[${i + 1}] 《${safeTitle}》：${safeText}`;
        })
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
        // Fallback on LLM error: only use first 3 chunks, align citations
        const fallback = buildFallbackAnswer(question, chunks);
        answer = fallback.answer;
        answeredChunks = fallback.usedChunks;
      }
    } else {
      // Deterministic fallback: concatenate chunk title + snippet (first 3 only)
      const fallback = buildFallbackAnswer(question, chunks);
      answer = fallback.answer;
      answeredChunks = fallback.usedChunks;
    }

    // citations 仅列实际参与答案的 chunk，与 answer 内容一致
    const citations: RagCitation[] = answeredChunks.map((c) => ({
      id: c.id,
      title: c.title,
      ...(c.sourceUrl ? { sourceUrl: c.sourceUrl } : {})
    }));

    return reply.send({ answer, citations } satisfies RagQueryResponse);
  });
}

/** Deterministic answer when no LLM is available: stitch retrieved chunk summaries.
 *  Returns both the answer string and the chunks actually used, so citations can align. */
function buildFallbackAnswer(
  question: string,
  chunks: RagChunk[]
): { answer: string; usedChunks: RagChunk[] } {
  if (chunks.length === 0) {
    return {
      answer: "暂无相关资料，请先导入参考文献后再提问。",
      usedChunks: []
    };
  }
  const usedChunks = chunks.slice(0, 3);
  const parts = usedChunks.map((c) => `《${c.title}》：${c.text.slice(0, 120)}`);
  return {
    answer: `关于"${question}"，根据已导入资料整理如下：\n\n${parts.join("\n\n")}`,
    usedChunks
  };
}
