import type { ProductState } from "../../../../src/domain/types";
import type { RecallResult, RecallProvenanceEntry } from "../../../../src/domain/recall";
import type { NativeRecallPort } from "./native-recall-port";

// 溯源有界:最多对前 N 个召回资产取证据,每资产最多 M 条 turn,防 context 膨胀。
const PROVENANCE_MAX_ASSETS = 6;
const PROVENANCE_MAX_TURNS = 3;

/**
 * P2b:surreal 权威时 server 侧预召回。并行图遍历(主题资产)+ HNSW(记忆向量)+ 溯源(证据 turn),
 * 组装成纯数据 RecallResult 喂给同步域函数。
 * 真实性原则:任一路召回失败即向上抛,由调用方（建会话路由）如实 5xx——
 * 不再逐路吞错返回 undefined 让会话"看起来成功但少了召回"。
 */
export async function prefetchRecall(
  port: NativeRecallPort,
  state: ProductState,
  topicHint: string,
  queryEmbedding: number[] | undefined,
  opts: { includeSensitive: boolean; topN: number }
): Promise<RecallResult> {
  // 审计修复(P3-43):与域内 resolveInterviewTopicHint 对齐——仅【名字匹配】的主题参与图召回。
  // 此前名字不匹配即回退"出现次数最高的旧主题",导致显式新话题会话被无关旧主题资产污染
  // (原生分支只排序不过滤)。新话题无匹配主题 → themeId undefined → 该路召回自然为空,正确。
  const theme = state.themes.find((t) => t.name === topicHint);
  const themeId = theme?.id;

  // 方案一:rag_chunk 原生混合召回是可选能力(仅 surreal 权威档位),typeof 探测 + bind 后使用。
  const recallRag = typeof port.recallRagChunks === "function" ? port.recallRagChunks.bind(port) : undefined;
  const trimmedHint = topicHint.trim();

  const [themeAssets, memoryHits, ragHits] = await Promise.all([
    themeId ? port.recallThemeAssets(themeId) : Promise.resolve(undefined),
    queryEmbedding && queryEmbedding.length > 0
      ? // 大候选集(topN*4)逼近精确,A4 门控由 includeSensitive 传入;三因子精排在域层叠加。
        // ③ 混合检索:topicHint 作为 queryText 叠加 BM25(补 HNSW 对专名/精确词的盲区)。
        port.recallMemoriesByVector(queryEmbedding, Math.max(opts.topN, 5) * 4, {
          includeSensitive: opts.includeSensitive,
          ...(topicHint ? { queryText: topicHint } : {})
        })
      : Promise.resolve(undefined),
    // 方案一:rag_chunk 混合召回(HNSW+BM25+rrf)。有 embedding 走混合;只有 topicHint 走 BM25-only;
    // 皆缺/无能力 → undefined。过取一档(topN*2):域层 buildSemanticRagContextFromRecall 还要按
    // usage/来源 policy 重验门控后截断到 contextSourceLimit(= topN 同源的 maxSources)。
    recallRag && ((queryEmbedding && queryEmbedding.length > 0) || trimmedHint.length > 0)
      ? recallRag({
          ...(queryEmbedding && queryEmbedding.length > 0 ? { embedding: queryEmbedding } : {}),
          ...(trimmedHint ? { queryText: trimmedHint } : {}),
          k: Math.max(opts.topN, 1) * 2,
          usage: "interview-context"
        })
      : Promise.resolve(undefined)
  ]);

  // 溯源:对召回出的 point/decision(有界)沿 derived_from 取证据 turn。
  let provenance: RecallProvenanceEntry[] | undefined;
  if (themeAssets) {
    const targets: Array<{ table: string; id: string }> = [
      ...themeAssets.points.map((id) => ({ table: "point", id })),
      ...themeAssets.decisions.map((id) => ({ table: "decision", id }))
    ].slice(0, PROVENANCE_MAX_ASSETS);
    const entries = await Promise.all(
      targets.map(async (t) => {
        // 方案三:includeSensitive 透传敏感纵深门控(敏感来源资产默认不溯源,与记忆召回口径一致)。
        const turns = await port.recallProvenanceTurns(t.table, t.id, { includeSensitive: opts.includeSensitive });
        return turns.length > 0 ? { assetTable: t.table, assetId: t.id, turns: turns.slice(0, PROVENANCE_MAX_TURNS) } : undefined;
      })
    );
    const filtered = entries.filter((e): e is RecallProvenanceEntry => Boolean(e));
    provenance = filtered.length > 0 ? filtered : undefined;
  }

  return {
    ...(themeAssets ? { themeAssets } : {}),
    ...(memoryHits ? { memoryHits } : {}),
    ...(provenance ? { provenance } : {}),
    ...(ragHits && ragHits.length > 0 ? { ragHits } : {})
  };
}
