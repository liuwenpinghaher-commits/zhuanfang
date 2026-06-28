/**
 * P2b:server 层使用的原生召回端口。
 *
 * 三个方法的签名是 SurrealRepoHandle(packages/db)的子集,故 SurrealRepoHandle 结构兼容本接口——
 * 无需在域层 import 任何 repo。`hasNativeRecall` 用结构守卫探测某个 repo 是否具备原生召回能力。
 */
export interface NativeRecallPort {
  recallThemeAssets(themeId: string): Promise<{ points: string[]; decisions: string[]; questions: string[]; memories: string[] }>;
  recallMemoriesByVector(embedding: number[], k: number, opts?: { includeSensitive?: boolean; queryText?: string }): Promise<Array<{ id: string; text: string }>>;
  recallProvenanceTurns(table: string, id: string): Promise<Array<{ id: string; content: string; sessionId: string; role: string }>>;
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
