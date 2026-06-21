import type { FastifyInstance } from "fastify";
import type { InterviewTurn, KnowledgeChunk, ProductState } from "../../../../src/domain/types";
import type { ProductStateRepository } from "../product-state-repository";
import type { RawMaterialRepository } from "../raw-material-repository";
import type { KnowledgeIndexRepository } from "../knowledge-index-repository";
import type { BailianEmbeddingClient } from "../providers/bailian";
import { createLlmBudget, type LlmBudget } from "../llm-budget";
import { buildKnowledgeChunks, diffIndexableSources } from "../../../../src/domain/knowledge";

// Bailian text-embedding 单次请求最多 10 条 input，超过会 400。批量大小必须 ≤ 10。
const EMBED_BATCH = 10;

/**
 * 批量给 chunks 补嵌入。无 client / 超预算 / 失败 → 留空(走关键词召回)，绝不抛。
 * 预算走共享 LlmBudget 的 "knowledge_index" 桶(任意字符串 capability，tryConsume 不限 union)。
 */
// 嵌入 API 对空串/超长文本会 400，对单批文本数也有上限。送入前清洗：截断超长、剔空。
const MAX_EMBED_CHARS = 2000;
const MAX_EMBED_FAILURES = 3; // 连续失败上限：API 真挂了就尽快停，别 42 批逐个超时拖死。

export async function embedChunks(
  chunks: KnowledgeChunk[],
  embeddingClient: BailianEmbeddingClient | undefined,
  budget: LlmBudget
): Promise<KnowledgeChunk[]> {
  if (!embeddingClient || chunks.length === 0 || !budget.tryConsume("knowledge_index")) {
    return chunks;
  }
  const out = [...chunks];
  // 只对有非空文本的块取嵌入；空文本块跳过(保留关键词召回)。记下原始下标以便回填。
  const targets = out
    .map((c, idx) => ({ idx, text: c.text.trim().slice(0, MAX_EMBED_CHARS) }))
    .filter((t) => t.text.length > 0);
  let consecutiveFailures = 0;
  for (let i = 0; i < targets.length; i += EMBED_BATCH) {
    const slice = targets.slice(i, i + EMBED_BATCH);
    try {
      const vecs = await embeddingClient.embed(slice.map((t) => t.text));
      slice.forEach((t, j) => {
        if (Array.isArray(vecs[j]) && vecs[j].length > 0) {
          out[t.idx] = { ...out[t.idx], embedding: vecs[j] };
        }
      });
      consecutiveFailures = 0;
    } catch (err) {
      console.warn(
        JSON.stringify({
          event: "knowledge_embed_failed",
          error: err instanceof Error ? err.message : String(err)
        })
      );
      // 跳过这一批(其块留关键词召回)，继续后续批；连续失败过多则判定 API 不可用，提前停。
      consecutiveFailures += 1;
      if (consecutiveFailures >= MAX_EMBED_FAILURES) {
        break;
      }
    }
  }
  return out;
}

/**
 * 持久化边界增量重索引：对 prev→next 的可索引资产 diff，删除被删来源的块、重建变更来源的块。
 * material/transcript 不在此处（由 import / /end 单独补点）。
 *
 * fire-and-forget 语义：调用方 void 它、不 await；本函数自身整体 try/catch 吞所有异常，
 * 绝不把错误抛回写路径——重索引失败只记一条 warn，不影响已落库的状态写入。
 */
export async function reindexOnStateChange(
  prev: ProductState,
  next: ProductState,
  knowledgeRepo: KnowledgeIndexRepository,
  embeddingClient: BailianEmbeddingClient | undefined,
  budget: LlmBudget
): Promise<void> {
  try {
    const diff = diffIndexableSources(prev, next);

    // 先处理删除：被删来源的块直接清掉。
    for (const ref of diff.removed) {
      knowledgeRepo.deleteBySource(ref.sourceType, ref.sourceId);
    }

    // material 不在 diffIndexableSources 内（新增/变更由 import 端点补点），但"删除"必须在此清理：
    // 前端 deleteImportSource 只清 ProductState 的 importSources/ragChunks，不动知识索引；
    // 经包装的 replaceState → 本函数收到 prev/next，比对 importSources 按 id，
    // 对 prev 有、next 无的来源逐个删其 material 块，避免删素材后遗留孤儿块仍被 chat 引用。
    const nextSourceIds = new Set(next.importSources.map((s) => s.id));
    for (const source of prev.importSources) {
      if (!nextSourceIds.has(source.id)) {
        knowledgeRepo.deleteBySource("material", source.id);
      }
    }

    if (diff.changed.length === 0) return;

    // 对 changed 的来源：从 next 全量切块，再过滤出这些来源的块。
    // 增量不含 transcript（空 map），material 在 next.importSources 里但不会出现在 changedKeys 中。
    const changedKeys = new Set(diff.changed.map((r) => `${r.sourceType}::${r.sourceId}`));
    const allChunks = buildKnowledgeChunks(next, new Map());
    const relevant = allChunks.filter((c) => changedKeys.has(`${c.sourceType}::${c.sourceId}`));
    const embedded = await embedChunks(relevant, embeddingClient, budget);

    // 按来源分组后整组 replaceSource，保证一个来源的旧块被一次性替换（即便它现在没有块也清空）。
    const bySource = new Map<string, KnowledgeChunk[]>();
    for (const c of embedded) {
      const k = `${c.sourceType}::${c.sourceId}`;
      const list = bySource.get(k);
      if (list) {
        list.push(c);
      } else {
        bySource.set(k, [c]);
      }
    }
    for (const ref of diff.changed) {
      const k = `${ref.sourceType}::${ref.sourceId}`;
      knowledgeRepo.replaceSource(ref.sourceType, ref.sourceId, bySource.get(k) ?? []);
    }
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "reindex_failed",
        error: err instanceof Error ? err.message : String(err)
      })
    );
  }
}

/**
 * import 端点专用补点：把指定 importSource 的 material 块重建进索引。
 * material 不在 diffIndexableSources 内（内容截断、不走 PUT 编辑路径），故由 import 显式补。
 * fire-and-forget 友好：整体 try/catch，绝不抛。
 */
export async function reindexMaterial(
  state: ProductState,
  sourceId: string,
  knowledgeRepo: KnowledgeIndexRepository,
  embeddingClient: BailianEmbeddingClient | undefined,
  budget: LlmBudget
): Promise<void> {
  try {
    const chunks = buildKnowledgeChunks(state, new Map()).filter(
      (c) => c.sourceType === "material" && c.sourceId === sourceId
    );
    const embedded = await embedChunks(chunks, embeddingClient, budget);
    knowledgeRepo.replaceSource("material", sourceId, embedded);
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "reindex_material_failed",
        sourceId,
        error: err instanceof Error ? err.message : String(err)
      })
    );
  }
}

/**
 * /end 端点专用补点：会话降冷后，把该会话的 transcript 块（逐字稿冷层）重建进索引。
 * transcript 不在 ProductState 里（属冷层），需调用方把该会话的 turns 传入。
 * 按 buildKnowledgeChunks 的约定，transcript 的 sourceId 形如 `${sessionId}#${turnId}`，
 * 故按 sourceId 逐条 replaceSource。fire-and-forget 友好：整体 try/catch，绝不抛。
 */
export async function reindexTranscript(
  state: ProductState,
  sessionId: string,
  turns: InterviewTurn[],
  knowledgeRepo: KnowledgeIndexRepository,
  embeddingClient: BailianEmbeddingClient | undefined,
  budget: LlmBudget
): Promise<void> {
  try {
    const all = buildKnowledgeChunks(state, new Map([[sessionId, turns]]));
    const chunks = all.filter(
      (c) => c.sourceType === "transcript" && c.sourceId.startsWith(`${sessionId}#`)
    );
    const embedded = await embedChunks(chunks, embeddingClient, budget);
    // 每条 user 轮一个独立 sourceId，逐条整组替换。
    const bySource = new Map<string, KnowledgeChunk[]>();
    for (const c of embedded) {
      const list = bySource.get(c.sourceId);
      if (list) {
        list.push(c);
      } else {
        bySource.set(c.sourceId, [c]);
      }
    }
    for (const [sid, list] of bySource) {
      knowledgeRepo.replaceSource("transcript", sid, list);
    }
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "reindex_transcript_failed",
        sessionId,
        error: err instanceof Error ? err.message : String(err)
      })
    );
  }
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

    const chunks = buildKnowledgeChunks(state, rawTurns);

    // 全量重建：先清空旧索引、立即写入(无嵌入也能关键词召回)并返回——避免 HTTP 请求
    // 阻塞在数百次嵌入上(嵌入 API 慢时会拖到分钟级、卡死前端重建按钮)。
    knowledgeRepo.deleteAll();
    for (const chunk of chunks) {
      knowledgeRepo.put(chunk);
    }

    // 嵌入在后台补：每补好一条就 upsert 覆盖(put 按 id 覆盖)，召回随之从关键词升级到向量。失败只 warn。
    const budget = options.llmBudget ?? createLlmBudget();
    void embedChunks(chunks, options.embeddingClient, budget)
      .then((embedded) => {
        for (const chunk of embedded) {
          if (chunk.embedding && chunk.embedding.length > 0) {
            knowledgeRepo.put(chunk);
          }
        }
      })
      .catch((err) => {
        console.warn(
          JSON.stringify({
            event: "knowledge_background_embed_failed",
            error: err instanceof Error ? err.message : String(err)
          })
        );
      });

    return { chunkCount: chunks.length };
  });
}
