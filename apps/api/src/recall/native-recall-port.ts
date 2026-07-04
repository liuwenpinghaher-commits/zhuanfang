/**
 * P2b:server 层使用的原生召回端口。
 *
 * 三个方法的签名是 SurrealRepoHandle(packages/db)的子集,故 SurrealRepoHandle 结构兼容本接口——
 * 无需在域层 import 任何 repo。`hasNativeRecall` 用结构守卫探测某个 repo 是否具备原生召回能力。
 */
export interface NativeRecallPort {
  recallThemeAssets(themeId: string): Promise<{ points: string[]; decisions: string[]; questions: string[]; memories: string[] }>;
  recallMemoriesByVector(embedding: number[], k: number, opts?: { includeSensitive?: boolean; queryText?: string }): Promise<Array<{ id: string; text: string }>>;
  /** 方案三:opts.includeSensitive 透传敏感纵深门控(敏感来源资产默认不溯源)。 */
  recallProvenanceTurns(table: string, id: string, opts?: { includeSensitive?: boolean }): Promise<Array<{ id: string; content: string; sessionId: string; role: string }>>;
  /** 可选能力(方案一):rag_chunk 原生混合召回(HNSW+BM25+search::rrf)。仅 surreal 权威档位提供;
   *  消费点须 typeof 探测,缺失/抛错/为空一律回落域层纯函数(buildSemanticRagContext),绝不破坏现状。
   *  不进 hasNativeRecall 必选守卫——避免将来别的 native repo 只实现三件套时被整体判为无能力。 */
  recallRagChunks?(opts: { embedding?: number[]; queryText?: string; k: number; usage?: "interview-context" | "memory-candidate" }): Promise<Array<{ id: string; text: string }>>;
}

export function hasNativeRecall(x: unknown): x is NativeRecallPort {
  const r = x as Partial<NativeRecallPort> | null;
  return (
    !!r &&
    typeof r.recallThemeAssets === "function" &&
    typeof r.recallMemoriesByVector === "function" &&
    typeof r.recallProvenanceTurns === "function"
  );
}
