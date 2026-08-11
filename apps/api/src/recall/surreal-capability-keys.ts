/**
 * C11 · Surreal 能力键同源清单。
 *
 * 生产装配链:createSurrealStores → (optional) user-scoped Proxy facade → withKnowledgeReindex(Proxy 转发)。
 * `withKnowledgeReindex` import 本清单(钉住探测面);路由经 `asNativeRecall` / `asGovernanceTx` /
 * typeof 探测。禁止对 user-scoped Proxy 做 object spread(会丢掉 get-trap 能力键)。
 *
 * 不进本清单:recallRagChunks?(可选)、flush/confirmPersisted/getGovernanceGeneration(基础/代际,
 * 由 withKnowledgeReindex Proxy 同样转发)。装配约定见 server.ts——勿堆进根 AGENTS.md。
 */
export const SURREAL_CAPABILITY_KEYS = [
  "runGovernanceTransaction",
  "getPersistHealth",
  "auditGraphConsistency",
  "recallThemeAssets",
  "recallMemoriesByVector",
  "recallProvenanceTurns",
] as const;

export type SurrealCapabilityKey = (typeof SURREAL_CAPABILITY_KEYS)[number];
