/**
 * C11 · Surreal 能力键同源清单。
 *
 * 生产装配链:createSurrealStores → (optional) user-scoped Proxy facade → withKnowledgeReindex(...inner spread)。
 * 路由经 `asNativeRecall` / `asGovernanceTx` / 直接 typeof 探测这些方法;清单与探测字段同源,
 * 避免 hasNativeRecall / asGovernanceTx / 装配契约测三处各自维护而漂移。
 *
 * 不进本清单:recallRagChunks?(可选)、flush/confirmPersisted/getGovernanceGeneration(基础/代际,
 * 已有专测)。装配约定见各 port 注释——勿堆进根 AGENTS.md。
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
