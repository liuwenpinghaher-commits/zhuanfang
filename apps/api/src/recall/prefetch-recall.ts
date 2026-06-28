import type { ProductState } from "../../../../src/domain/types";
import type { RecallResult, RecallProvenanceEntry } from "../../../../src/domain/recall";
import type { NativeRecallPort } from "./native-recall-port";

// 溯源有界:最多对前 N 个召回资产取证据,每资产最多 M 条 turn,防 context 膨胀。
const PROVENANCE_MAX_ASSETS = 6;
const PROVENANCE_MAX_TURNS = 3;

/** 单路召回 fail-safe:抛错 → 记降级日志 + 返回 undefined(域函数对应回落),绝不冒泡阻断 session。 */
async function safe<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (error) {
    console.warn(
      JSON.stringify({ event: "prefetch_recall_degraded", label, error: error instanceof Error ? error.message : String(error) })
    );
    return undefined;
  }
}

/**
 * P2b:surreal 权威时 server 侧预召回。并行图遍历(主题资产)+ HNSW(记忆向量)+ 溯源(证据 turn),
 * 组装成纯数据 RecallResult 喂给同步域函数。每路独立 fail-safe;整体绝不抛。
 */
export async function prefetchRecall(
  port: NativeRecallPort,
  state: ProductState,
  topicHint: string,
  queryEmbedding: number[] | undefined,
  opts: { includeSensitive: boolean; topN: number }
): Promise<RecallResult> {
  // 与域内 resolveInterviewTopicHint 的主题归属对齐:优先名字匹配,否则出现次数最高的主题。
  const theme = state.themes.find((t) => t.name === topicHint) ?? [...state.themes].sort((a, b) => b.appearances - a.appearances)[0];
  const themeId = theme?.id;

  const [themeAssets, memoryHits] = await Promise.all([
    themeId ? safe("themeAssets", () => port.recallThemeAssets(themeId)) : Promise.resolve(undefined),
    queryEmbedding && queryEmbedding.length > 0
      ? safe("memoryHits", () =>
          // 大候选集(topN*4)逼近精确,A4 门控由 includeSensitive 传入;三因子精排在域层叠加。
          // ③ 混合检索:topicHint 作为 queryText 叠加 BM25(补 HNSW 对专名/精确词的盲区);
          //    无 topicHint / BM25 不可用 → recallMemoriesByVector 内部退化为纯 HNSW(fail-safe)。
          port.recallMemoriesByVector(queryEmbedding, Math.max(opts.topN, 5) * 4, {
            includeSensitive: opts.includeSensitive,
            ...(topicHint ? { queryText: topicHint } : {})
          })
        )
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
        const turns = (await safe("provenance", () => port.recallProvenanceTurns(t.table, t.id))) ?? [];
        return turns.length > 0 ? { assetTable: t.table, assetId: t.id, turns: turns.slice(0, PROVENANCE_MAX_TURNS) } : undefined;
      })
    );
    const filtered = entries.filter((e): e is RecallProvenanceEntry => Boolean(e));
    provenance = filtered.length > 0 ? filtered : undefined;
  }

  return {
    ...(themeAssets ? { themeAssets } : {}),
    ...(memoryHits ? { memoryHits } : {}),
    ...(provenance ? { provenance } : {})
  };
}
