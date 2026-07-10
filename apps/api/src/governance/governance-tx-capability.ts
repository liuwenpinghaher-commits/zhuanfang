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
 * 探测某个 repo 是否具备治理事务能力(与 asNativeRecall 同款注入矩阵):
 * - `surreal` 档:repo 自身(经 withKnowledgeReindex 的 `...inner` spread 透传)带
 *   runGovernanceTransaction → 直接返回。
 * - `dual`/`dual-surreal`/`sqlite`/`memory`:无此方法(dual-surreal 的 authoritative 是 standalone
 *   surreal handle,冷层却是 sqlite、不同连接,不配得真跨冷热事务,故 createSurrealStores 之外一律
 *   不暴露) → getAuthoritative 也取不到 → undefined,路由回落既有 journal/best-effort。
 */
export function asGovernanceTx(repo: unknown): GovernanceTransactionPort | undefined {
  if (hasGovernanceTx(repo)) return repo;
  const auth = (repo as { getAuthoritative?: () => unknown } | null)?.getAuthoritative?.();
  if (hasGovernanceTx(auth)) return auth;
  return undefined;
}
