import type { FastifyInstance } from "fastify";
import type { InterviewTurn, KnowledgeChunk, ProductState } from "../../../../src/domain/types";
import type { ProductStateRepository } from "../product-state-repository";
import { replaceStateDurable } from "../product-state-repository";
import type { RawMaterialRepository } from "../raw-material-repository";
import type { KnowledgeIndexRepository } from "../knowledge-index-repository";
import type { BailianEmbeddingClient } from "../providers/bailian";
import { createLlmBudget, type LlmBudget } from "../llm-budget";
import { buildKnowledgeChunks, diffIndexableSources } from "../../../../src/domain/knowledge";
import type { WriteGate } from "../server";
import { recordReindexEvent } from "../observability/runtime-metrics";

// Bailian text-embedding 单次请求最多 10 条 input，超过会 400。批量大小必须 ≤ 10。
const EMBED_BATCH = 10;

/**
 * 批量给 chunks 补嵌入。无 client / 超预算 / 失败 → 留空(走关键词召回)，绝不抛。
 * 预算走共享 LlmBudget 的 "knowledge_index" 桶(任意字符串 capability，tryConsume 不限 union)。
 */
// 嵌入 API 对空串/超长文本会 400，对单批文本数也有上限。送入前清洗：截断超长、剔空。
// 回归审查 R6-5:单一 embedding 输入截断上限,approve/PATCH重嵌/rebuild重嵌 全部共用,
// 保证同一条记忆多次嵌入落在同一向量空间(此前 approve 全文、PATCH 截断 2000 → >2000字记忆两次向量漂移)。
export const MAX_EMBED_CHARS = 2000;
const MAX_EMBED_FAILURES = 3; // 连续失败上限：API 真挂了就尽快停，别 42 批逐个超时拖死。

export async function embedChunks(
  chunks: KnowledgeChunk[],
  embeddingClient: BailianEmbeddingClient | undefined,
  budget: LlmBudget
): Promise<KnowledgeChunk[]> {
  if (!embeddingClient || chunks.length === 0) {
    return chunks;
  }
  if (!budget.tryConsume("knowledge_index")) {
    // 审计修复(P3-36):此前是全库唯一零信号的预算拒绝分支——嵌入静默关闭、召回退化无从察觉。
    console.warn(JSON.stringify({ event: "llm_budget_exceeded", capability: "knowledge_index" }));
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
 * 绝不把错误抛回写路径——重索引失败只记一条 warn + metrics，不影响已落库的状态写入。
 *
 * PR-O3: 结构化 success/fail 日志 + runtime-metrics reindex 计数/环形缓冲（写路径默认仍不 await）。
 */
export async function reindexOnStateChange(
  prev: ProductState,
  next: ProductState,
  knowledgeRepo: KnowledgeIndexRepository,
  embeddingClient: BailianEmbeddingClient | undefined,
  budget: LlmBudget,
  opts?: { userKey?: string }
): Promise<void> {
  const started = Date.now();
  const userKey = opts?.userKey;
  try {
    const diff = diffIndexableSources(prev, next);

    // 先处理删除：被删来源的块直接清掉。（R2a:仓库接口已异步化，逐个 await）
    for (const ref of diff.removed) {
      await knowledgeRepo.deleteBySource(ref.sourceType, ref.sourceId);
    }

    // material 不在 diffIndexableSources 内（新增/变更由 import 端点补点），但"删除"必须在此清理：
    // 前端 deleteImportSource 只清 ProductState 的 importSources/ragChunks，不动知识索引；
    // 经包装的 replaceState → 本函数收到 prev/next，比对 importSources 按 id，
    // 对 prev 有、next 无的来源逐个删其 material 块，避免删素材后遗留孤儿块仍被 chat 引用。
    const nextSourceIds = new Set(next.importSources.map((s) => s.id));
    let materialRemoved = 0;
    for (const source of prev.importSources) {
      if (!nextSourceIds.has(source.id)) {
        await knowledgeRepo.deleteBySource("material", source.id);
        materialRemoved += 1;
      }
    }

    // transcript 同理：逐字稿块属冷层、不在 diffIndexableSources 内。若某会话从 sessions[] 消失,
    // 其 transcript 块(sourceId 形如 `${sessionId}#${turnId}`)必须一并清,避免指向已不存在会话的孤儿块仍被 chat 召回。
    // 防御性:当前系统无"删除单会话"入口(/end 会重新加回会话),但保持与 material 删除对称的跨库一致性。
    const nextSessionIds = new Set(next.sessions.map((s) => s.id));
    const removedSessionIds = prev.sessions.filter((s) => !nextSessionIds.has(s.id)).map((s) => s.id);
    if (removedSessionIds.length > 0) {
      for (const chunk of await knowledgeRepo.listAll()) {
        if (chunk.sourceType !== "transcript") continue;
        const sid = chunk.sourceId.split("#")[0];
        if (removedSessionIds.includes(sid)) {
          await knowledgeRepo.deleteBySource("transcript", chunk.sourceId);
        }
      }
    }

    const baseCounts = {
      removedSources: diff.removed.length,
      changedSources: diff.changed.length,
      materialRemoved,
      transcriptSessionsRemoved: removedSessionIds.length,
      userKey
    };

    if (diff.changed.length === 0) {
      // 仅删除/无变更：仍记一次可观测事件（noop 或 success with zero embeds）。
      const onlyDeletes =
        diff.removed.length > 0 || materialRemoved > 0 || removedSessionIds.length > 0;
      const durationMs = Date.now() - started;
      if (onlyDeletes) {
        console.info(
          JSON.stringify({
            event: "reindex_ok",
            outcome: "success",
            phase: "delete_only",
            durationMs,
            ...baseCounts,
            chunkCount: 0,
            embeddedCount: 0
          })
        );
        recordReindexEvent({
          outcome: "success",
          ...baseCounts,
          chunkCount: 0,
          embeddedCount: 0,
          durationMs
        });
      } else {
        recordReindexEvent({ outcome: "noop", ...baseCounts, durationMs });
      }
      return;
    }

    // 对 changed 的来源：从 next 全量切块，再过滤出这些来源的块。
    // 增量不含 transcript（空 map），material 在 next.importSources 里但不会出现在 changedKeys 中。
    const changedKeys = new Set(diff.changed.map((r) => `${r.sourceType}::${r.sourceId}`));
    const allChunks = buildKnowledgeChunks(next, new Map());
    const relevant = allChunks.filter((c) => changedKeys.has(`${c.sourceType}::${c.sourceId}`));
    // R8-1:embed 前捕获代际,若嵌入期间被 reset/purge 清空则整批丢弃(不复活已清块)。
    const epochAtEmbed = await knowledgeRepo.epoch();
    const embedded = await embedChunks(relevant, embeddingClient, budget);
    if (await knowledgeRepo.epoch() !== epochAtEmbed) {
      const durationMs = Date.now() - started;
      console.warn(
        JSON.stringify({
          event: "reindex_discarded_stale_epoch",
          durationMs,
          ...baseCounts,
          chunkCount: relevant.length
        })
      );
      recordReindexEvent({
        outcome: "stale_discarded",
        ...baseCounts,
        chunkCount: relevant.length,
        durationMs
      });
      return;
    }

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
      // N-04:回写循环内每源复查代际——嵌入后到逐源 replaceSource 期间若 reset/purge 提交清空索引
      // (bumpEpoch),剩余源不得再写回(否则复活已清私密块)。单次前置检查(epochAtEmbed)挡不住中途清空。
      if (await knowledgeRepo.epoch() !== epochAtEmbed) {
        const durationMs = Date.now() - started;
        console.warn(
          JSON.stringify({
            event: "reindex_discarded_stale_epoch",
            phase: "midloop",
            durationMs,
            ...baseCounts,
            chunkCount: relevant.length
          })
        );
        recordReindexEvent({
          outcome: "stale_discarded",
          ...baseCounts,
          chunkCount: relevant.length,
          durationMs
        });
        return;
      }
      const k = `${ref.sourceType}::${ref.sourceId}`;
      await knowledgeRepo.replaceSource(ref.sourceType, ref.sourceId, bySource.get(k) ?? []);
    }

    const embeddedCount = embedded.filter(
      (c) => Array.isArray(c.embedding) && c.embedding.length > 0
    ).length;
    const durationMs = Date.now() - started;
    console.info(
      JSON.stringify({
        event: "reindex_ok",
        outcome: "success",
        durationMs,
        ...baseCounts,
        chunkCount: embedded.length,
        embeddedCount
      })
    );
    recordReindexEvent({
      outcome: "success",
      ...baseCounts,
      chunkCount: embedded.length,
      embeddedCount,
      durationMs
    });
  } catch (err) {
    const durationMs = Date.now() - started;
    const error = err instanceof Error ? err.message : String(err);
    console.warn(
      JSON.stringify({
        event: "reindex_failed",
        outcome: "failed",
        durationMs,
        error,
        userKey
      })
    );
    recordReindexEvent({
      outcome: "failed",
      durationMs,
      error,
      userKey
    });
  }
}

/**
 * import 端点专用补点：把指定 importSource 的 material 块重建进索引。
 * material 不在 diffIndexableSources 内（内容截断、不走 PUT 编辑路径），故由 import 显式补。
 * fire-and-forget 友好：整体 try/catch，绝不抛。
 */
export type ReindexMaterialResult = {
  chunkCount: number;
  embeddedCount: number;
  failed: boolean;
  staleDiscarded: boolean;
};

export async function reindexMaterial(
  state: ProductState,
  sourceId: string,
  knowledgeRepo: KnowledgeIndexRepository,
  embeddingClient: BailianEmbeddingClient | undefined,
  budget: LlmBudget
): Promise<ReindexMaterialResult> {
  try {
    const chunks = buildKnowledgeChunks(state, new Map()).filter(
      (c) => c.sourceType === "material" && c.sourceId === sourceId
    );
    const epochAtEmbed = await knowledgeRepo.epoch();   // R8-1
    const embedded = await embedChunks(chunks, embeddingClient, budget);
    if (await knowledgeRepo.epoch() !== epochAtEmbed) {
      return { chunkCount: chunks.length, embeddedCount: 0, failed: false, staleDiscarded: true };
    }
    await knowledgeRepo.replaceSource("material", sourceId, embedded);
    const embeddedCount = embedded.filter(
      (c) => Array.isArray(c.embedding) && c.embedding.length > 0
    ).length;
    return {
      chunkCount: chunks.length,
      embeddedCount,
      failed: false,
      staleDiscarded: false
    };
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "reindex_material_failed",
        sourceId,
        error: err instanceof Error ? err.message : String(err)
      })
    );
    return { chunkCount: 0, embeddedCount: 0, failed: true, staleDiscarded: false };
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
    const epochAtEmbed = await knowledgeRepo.epoch();   // R8-1
    const embedded = await embedChunks(chunks, embeddingClient, budget);
    if (await knowledgeRepo.epoch() !== epochAtEmbed) return;   // 中途清空则丢弃
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
      // N-04:每源复查代际(同 reindexOnStateChange)——中途 reset/purge 清空即停,不复活已清逐字稿块。
      if (await knowledgeRepo.epoch() !== epochAtEmbed) {
        console.warn(JSON.stringify({ event: "reindex_transcript_discarded_stale_epoch", sessionId, phase: "midloop" }));
        return;
      }
      await knowledgeRepo.replaceSource("transcript", sid, list);
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
  /** 回归审查 R4-4:后台 provider 重嵌的 replaceState 经此写门串行化,避免绕开全局写序列化 clobber 在途 HTTP 写。 */
  writeGate?: WriteGate;
}

/** 全量重建知识索引(审计修复 B2 抽取复用:rebuild 路由 / import 恢复 / purge scope=assets 共用)。
 *  同步部分:清空旧索引 + 立即写入关键词块(无嵌入即可召回);嵌入后台补,失败仅 warn。
 *  rawMaterialRepo 可缺省(state 路由等无冷层配置的调用方):transcript 块跳过,其余照常。
 *  R2a:仓库接口异步化后本函数改为 async——"同步部分"(清空+关键词写入+捕获 epoch)现在是
 *  await 到完成再 resolve 返回 chunkCount(语义不变:resolve 时关键词召回已就绪),嵌入仍后台补。 */
export async function rebuildKnowledgeIndex(
  state: ProductState,
  deps: {
    knowledgeRepo: KnowledgeIndexRepository;
    rawMaterialRepo?: RawMaterialRepository;
    embeddingClient?: BailianEmbeddingClient;
    budget: LlmBudget;
  }
): Promise<{ chunkCount: number }> {
  // 逐字稿属冷层，不在 ProductState 里——从 raw-material 仓库按会话补回。
  const rawTurns = new Map<string, InterviewTurn[]>();
  if (deps.rawMaterialRepo) {
    for (const session of state.sessions) {
      const material = await deps.rawMaterialRepo.get(session.id);
      if (material) {
        rawTurns.set(session.id, material.turns);
      }
    }
  }

  const chunks = buildKnowledgeChunks(state, rawTurns);

  // 全量重建：先清空旧索引、立即写入(无嵌入也能关键词召回)并返回——避免调用方
  // 阻塞在数百次嵌入上(嵌入 API 慢时会拖到分钟级)。
  await deps.knowledgeRepo.deleteAll();
  for (const chunk of chunks) {
    await deps.knowledgeRepo.put(chunk);
  }
  // 回归审查 R8-1:捕获本次重建的代际号。后台异步嵌入(数秒~分钟)期间若用户 reset/purge 清空了
  // 索引(epoch 递增),下面的 put 必须被丢弃——否则会把 reset 前构建的块 put 回索引 → chat 再召回
  // 已清空的私人内容(窄窗重开 P1-1 隐私症状)。
  const rebuildEpoch = await deps.knowledgeRepo.epoch();

  // 嵌入在后台补：每补好一条就 upsert 覆盖(put 按 id 覆盖)，召回随之从关键词升级到向量。失败只 warn。
  void embedChunks(chunks, deps.embeddingClient, deps.budget)
    .then(async (embedded) => {
      // R8-1:代际已变(中途被 reset/purge 清空)→ 整批陈旧嵌入丢弃,绝不复活已清私密块。
      if (await deps.knowledgeRepo.epoch() !== rebuildEpoch) {
        console.warn(JSON.stringify({ event: "knowledge_embed_discarded_stale_epoch", rebuildEpoch, current: await deps.knowledgeRepo.epoch() }));
        return;
      }
      // N-04:循环**内**每块复查代际——上面的单次检查只挡"嵌入期间已清空",挡不住"回写循环跑到一半时
      // 治理提交(DELETE knowledge_chunk + bumpEpoch)"。此时剩余块会继续 put 回已清空的索引 → chat 召回
      // "已清空"的私人内容。fire-and-forget 不持写门锁,"导入大资料→立刻 reset"真实可撞;每块前复查即断。
      for (const chunk of embedded) {
        if (await deps.knowledgeRepo.epoch() !== rebuildEpoch) {
          console.warn(JSON.stringify({ event: "knowledge_embed_discarded_stale_epoch", rebuildEpoch, phase: "midloop" }));
          return;
        }
        if (chunk.embedding && chunk.embedding.length > 0) {
          await deps.knowledgeRepo.put(chunk);
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
}

export async function registerKnowledgeRoutes(
  server: FastifyInstance,
  productRepo: ProductStateRepository,
  rawMaterialRepo: RawMaterialRepository,
  knowledgeRepo: KnowledgeIndexRepository,
  options: KnowledgeRouteOptions
): Promise<void> {
  server.post("/api/knowledge/rebuild", async () => {
    const budget = options.llmBudget ?? createLlmBudget();
    const state = productRepo.getState();
    const result = await rebuildKnowledgeIndex(state, {   // R2a:rebuildKnowledgeIndex 已异步化
      knowledgeRepo,
      rawMaterialRepo,
      embeddingClient: options.embeddingClient,
      budget
    });
    // 审计修复(P2-13):rebuild 兼作 EMBEDDING_PROVIDER 切换后的恢复工具——重嵌 provider 戳
    // 不匹配(含无戳历史数据)的 memoryRecords 与 state.ragChunks(此前二者无任何重嵌通道,
    // 切换后新旧向量跨空间混存,相似度≈噪声)。后台执行、fail-safe,不阻塞响应。
    const client = options.embeddingClient;
    if (client) {
      void (async () => {
        try {
          const current = client.providerId;
          const staleRecords = state.memoryRecords.filter(
            (r) => Array.isArray(r.embedding) && r.embedding.length > 0 && r.embeddingProvider !== current
          );
          const staleChunks = state.ragChunks.filter(
            (c) => Array.isArray(c.embedding) && c.embedding.length > 0 && c.embeddingProvider !== current
          );
          if (staleRecords.length === 0 && staleChunks.length === 0) return;
          if (!budget.tryConsume("knowledge_index")) {
            console.warn(JSON.stringify({ event: "llm_budget_exceeded", capability: "knowledge_index", phase: "reembed" }));
            return;
          }
          const embedBatch = async (texts: string[]) => {
            const out: number[][] = [];
            for (let i = 0; i < texts.length; i += 10) {
              out.push(...(await client.embed(texts.slice(i, i + 10).map((t) => t.slice(0, MAX_EMBED_CHARS)))));
            }
            return out;
          };
          const recVecs = await embedBatch(staleRecords.map((r) => r.text));
          const chunkVecs = await embedBatch(staleChunks.map((c) => c.text));
          const recById = new Map(staleRecords.map((r, i) => [r.id, recVecs[i]] as const));
          const chunkById = new Map(staleChunks.map((c, i) => [c.id, chunkVecs[i]] as const));
          // 回归审查 R4-4:embed(慢 IO)已在锁外完成;仅把"重读 latest + replaceState"的同步合并包进写门,
          // 避免后台 replaceState 绕开全局写序列化与在途 HTTP 写互相 clobber(此前直接 replaceState,
          // 并发下本次重嵌或用户写会被对方整态覆盖丢弃)。
          const applyReembed = async () => {
            const latest = productRepo.getState();
            return replaceStateDurable(productRepo, {
              ...latest,
              memoryRecords: latest.memoryRecords.map((r) => {
                const vec = recById.get(r.id);
                return vec && vec.length > 0 ? { ...r, embedding: vec, ...(current ? { embeddingProvider: current } : {}) } : r;
              }),
              ragChunks: latest.ragChunks.map((c) => {
                const vec = chunkById.get(c.id);
                return vec && vec.length > 0 ? { ...c, embedding: vec, ...(current ? { embeddingProvider: current } : {}) } : c;
              })
            });
          };
          if (options.writeGate) {
            await options.writeGate.runExclusive("knowledge-reembed", applyReembed);
          } else {
            await applyReembed();
          }
          console.info(JSON.stringify({ event: "embedding_reembed_done", records: staleRecords.length, chunks: staleChunks.length, provider: current }));
        } catch (err) {
          console.warn(JSON.stringify({ event: "embedding_reembed_failed", error: err instanceof Error ? err.message : String(err) }));
        }
      })();
    }
    return result;
  });
}
