import type { FastifyInstance } from "fastify";
import type { InterviewTurn, KnowledgeChunk } from "../../../../src/domain/types";
import type { ProductStateRepository } from "../product-state-repository";
import type { RawMaterialRepository } from "../raw-material-repository";
import type { KnowledgeIndexRepository } from "../knowledge-index-repository";
import type { BailianEmbeddingClient } from "../providers/bailian";
import { createLlmBudget, type LlmBudget } from "../llm-budget";
import { buildKnowledgeChunks } from "../../../../src/domain/knowledge";

const EMBED_BATCH = 32;

/**
 * 批量给 chunks 补嵌入。无 client / 超预算 / 失败 → 留空(走关键词召回)，绝不抛。
 * 预算走共享 LlmBudget 的 "knowledge_index" 桶(任意字符串 capability，tryConsume 不限 union)。
 */
export async function embedChunks(
  chunks: KnowledgeChunk[],
  embeddingClient: BailianEmbeddingClient | undefined,
  budget: LlmBudget
): Promise<KnowledgeChunk[]> {
  if (!embeddingClient || chunks.length === 0 || !budget.tryConsume("knowledge_index")) {
    return chunks;
  }
  const out = [...chunks];
  for (let i = 0; i < out.length; i += EMBED_BATCH) {
    const slice = out.slice(i, i + EMBED_BATCH);
    try {
      const vecs = await embeddingClient.embed(slice.map((c) => c.text));
      slice.forEach((c, j) => {
        if (vecs[j]) {
          out[i + j] = { ...c, embedding: vecs[j] };
        }
      });
    } catch (err) {
      console.warn(
        JSON.stringify({
          event: "knowledge_embed_failed",
          error: err instanceof Error ? err.message : String(err)
        })
      );
      break;
    }
  }
  return out;
}

export interface KnowledgeRouteOptions {
  embeddingClient?: BailianEmbeddingClient;
  llmBudget?: LlmBudget;
}

export async function registerKnowledgeRoutes(
  server: FastifyInstance,
  productRepo: ProductStateRepository,
  rawMaterialRepo: RawMaterialRepository,
  knowledgeRepo: KnowledgeIndexRepository,
  options: KnowledgeRouteOptions
): Promise<void> {
  server.post("/api/knowledge/rebuild", async () => {
    const state = productRepo.getState();

    // 逐字稿属冷层，不在 ProductState 里——从 raw-material 仓库按会话补回。
    const rawTurns = new Map<string, InterviewTurn[]>();
    for (const session of state.sessions) {
      const material = rawMaterialRepo.get(session.id);
      if (material) {
        rawTurns.set(session.id, material.turns);
      }
    }

    const budget = options.llmBudget ?? createLlmBudget();
    const chunks = await embedChunks(
      buildKnowledgeChunks(state, rawTurns),
      options.embeddingClient,
      budget
    );

    // 全量重建：先清空旧索引，再逐条写入(单线程同步，无并发竞态)。
    knowledgeRepo.deleteAll();
    for (const chunk of chunks) {
      knowledgeRepo.put(chunk);
    }

    return { chunkCount: chunks.length };
  });
}
