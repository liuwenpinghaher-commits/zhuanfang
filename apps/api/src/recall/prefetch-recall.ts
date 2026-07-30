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

/**
 * Resolve a theme for graph recall without falling back to "most appearances"
 * (that polluted new topics — P3-43). Prefer exact name, then conservative soft
 * containment / token overlap against topicHint + lexical query (R-P2-05).
 */
export function resolveThemeForPrefetch(
  state: ProductState,
  topicHint: string,
  queryText?: string
): ProductState["themes"][number] | undefined {
  const themeTopic = topicHint.trim();
  const lexical = (queryText ?? "").trim();
  if (!themeTopic && !lexical) return undefined;

  const exact =
    (themeTopic ? state.themes.find((t) => t.name === themeTopic) : undefined) ??
    (lexical ? state.themes.find((t) => t.name === lexical) : undefined);
  if (exact) return exact;

  const haystack = `${themeTopic}\n${lexical}`.toLowerCase();
  const scored = state.themes
    .map((theme) => {
      const name = theme.name.trim();
      if (name.length < 2) return null;
      const n = name.toLowerCase();
      let score = 0;
      if (haystack.includes(n)) score += 3 + Math.min(n.length, 12) / 12;
      else if (themeTopic && n.includes(themeTopic.toLowerCase()) && themeTopic.length >= 2) {
        score += 2;
      } else if (lexical && n.includes(lexical.toLowerCase()) && lexical.length >= 2) {
        score += 1.5;
      } else {
        // light token overlap for multi-char CJK / space-separated tokens
        const tokens = Array.from(
          new Set(
            `${themeTopic} ${lexical}`
              .split(/[\s,，。！？、；;:\/|]+/u)
              .map((x) => x.trim().toLowerCase())
              .filter((x) => x.length >= 2)
          )
        );
        let hits = 0;
        for (const tok of tokens) {
          if (n.includes(tok) || tok.includes(n)) hits += 1;
        }
        if (hits === 0) return null;
        score += hits;
      }
      if (score <= 0) return null;
      return { theme, score, appearances: theme.appearances ?? 0, len: name.length };
    })
    .filter((x): x is NonNullable<typeof x> => x != null)
    .sort((a, b) => b.score - a.score || b.len - a.len || b.appearances - a.appearances);

  // Require a minimum signal so unrelated high-frequency themes never win.
  const best = scored[0];
  if (!best || best.score < 1.5) return undefined;
  return best.theme;
}

export async function prefetchRecall(
  port: NativeRecallPort,
  state: ProductState,
  topicHint: string,
  queryEmbedding: number[] | undefined,
  opts: {
    includeSensitive: boolean;
    topN: number;
    /**
     * BM25 / hybrid lexical query. Mid-session paths pass the latest user utterance
     * so lexical recall tracks the turn while theme matching uses topicHint separately.
     * When omitted, falls back to topicHint.
     */
    queryText?: string;
  }
): Promise<RecallResult> {
  // P3-43: never fall back to "top appearances" theme (pollutes new topics).
  // R-P2-05: allow conservative soft match (containment / token overlap) so mid-session
  // drift still hits the graph when the user restates a known theme without exact equality.
  const theme = resolveThemeForPrefetch(state, topicHint, opts.queryText);
  const themeId = theme?.id;

  // 方案一:rag_chunk 原生混合召回是可选能力(仅 surreal 权威档位),typeof 探测 + bind 后使用。
  const recallRag = typeof port.recallRagChunks === "function" ? port.recallRagChunks.bind(port) : undefined;
  // R-P1-01: BM25/hybrid follows mid-session queryText when provided (not open-time freeze).
  const lexicalQuery = (opts.queryText ?? topicHint).trim();

  const [themeAssets, memoryHits, ragHits] = await Promise.all([
    themeId ? port.recallThemeAssets(themeId) : Promise.resolve(undefined),
    queryEmbedding && queryEmbedding.length > 0
      ? // 大候选集(topN*4)逼近精确,A4 门控由 includeSensitive 传入;三因子精排在域层叠加。
        // ③ 混合检索:lexicalQuery 作为 queryText 叠加 BM25(补 HNSW 对专名/精确词的盲区)。
        port.recallMemoriesByVector(queryEmbedding, Math.max(opts.topN, 5) * 4, {
          includeSensitive: opts.includeSensitive,
          ...(lexicalQuery ? { queryText: lexicalQuery } : {})
        })
      : Promise.resolve(undefined),
    // 方案一:rag_chunk 混合召回(HNSW+BM25+rrf)。有 embedding 走混合;只有 lexical 走 BM25-only;
    // 皆缺/无能力 → undefined。过取一档(topN*2):域层 buildSemanticRagContextFromRecall 还要按
    // usage/来源 policy 重验门控后截断到 contextSourceLimit(= topN 同源的 maxSources)。
    recallRag && ((queryEmbedding && queryEmbedding.length > 0) || lexicalQuery.length > 0)
      ? recallRag({
          ...(queryEmbedding && queryEmbedding.length > 0 ? { embedding: queryEmbedding } : {}),
          ...(lexicalQuery ? { queryText: lexicalQuery } : {}),
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
    // C-P1-05: only inject non-empty memoryHits. Empty [] is truthy in JS and would
    // collapse the domain memory pool instead of falling back to full confirmed set.
    ...(memoryHits && memoryHits.length > 0 ? { memoryHits } : {}),
    ...(provenance ? { provenance } : {}),
    ...(ragHits && ragHits.length > 0 ? { ragHits } : {})
  };
}
