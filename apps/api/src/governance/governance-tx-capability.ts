import type { InterviewAudio, InterviewRawMaterial, ProductState } from "../../../../src/domain/types";

/**
 * R2b · 治理事务(reset/purge/import 真 ACID)的能力探测,照 recall 的 asNativeRecall 注入矩阵做。
 *
 * 端口形状是 SurrealRepoHandle.runGovernanceTransaction 的结构子集,故 handle 结构兼容本接口——
 * 无需在 apps/api 侧 import 任何 surreal 类型(与 native-recall-port 同理,避开 @surrealdb/node 的
 * moduleResolution 问题)。这些 spec 类型与 packages/db 的 GovernanceHotSpec/GovernanceColdSpec
 * 逐字段对应(只引用领域类型),保持结构等价。
 */

export type GovernanceHotSpec =
  | { kind: "reset" }
  | { kind: "replace"; next: ProductState; expectedRevision?: number };

export interface GovernanceColdSpec {
  rawMaterial?: { action: "wipe" } | { action: "replace"; materials: InterviewRawMaterial[] };
  audio?: { action: "wipe" } | { action: "replace"; audios: InterviewAudio[] };
  knowledgeIndex?: { action: "wipe" };
}

export interface GovernanceTransactionPort {
  /** 单事务:热态整状态替换 + 冷层删/写,失败整体回滚(无部分提交)。见 SurrealRepoHandle 注释。 */
  runGovernanceTransaction(hot: GovernanceHotSpec, cold: GovernanceColdSpec): Promise<ProductState>;
}

export function hasGovernanceTx(x: unknown): x is GovernanceTransactionPort {
  const r = x as Partial<GovernanceTransactionPort> | null;
  return !!r && typeof r.runGovernanceTransaction === "function";
}

/**
 * 探测某个 repo 是否具备治理事务能力(与 asNativeRecall 同款注入矩阵)。R7 后仅两档:
 * - `surreal` 档:只有 createSurrealStores 装配路径(冷热共用一个嵌入式连接)的 handle 才带
 *   runGovernanceTransaction(经 withKnowledgeReindex 的 `...inner` spread 透传)→ 直接返回。
 *   standalone createSurrealProductStateRepository(自开自关连接、无冷层)不暴露此方法。
 * - `memory` 档:无此方法 → undefined,路由回落既有 journal/best-effort。
 * (dual-write/dual-surreal 已随 R7 删除,不再有 getAuthoritative 委托层。)
 */
export function asGovernanceTx(repo: unknown): GovernanceTransactionPort | undefined {
  return hasGovernanceTx(repo) ? repo : undefined;
}
