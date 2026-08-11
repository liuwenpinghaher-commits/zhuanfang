import { hasNativeRecall, type NativeRecallPort } from "./native-recall-port";

/**
 * P2b 注入矩阵:按权威库探测原生召回能力。R7 后仅两档:
 * - `surreal` 档:repo 自身是 SurrealRepoHandle(经 withKnowledgeReindex 的 live getter/Proxy 转发)
 *   → 直接返回。
 * - `memory` 档:无原生能力 → undefined,召回走域层纯函数回落。
 * (dual-write/dual-surreal 已随 R7 删除,不再有 getAuthoritative 委托层。)
 */
export function asNativeRecall(repo: unknown): NativeRecallPort | undefined {
  return hasNativeRecall(repo) ? repo : undefined;
}
