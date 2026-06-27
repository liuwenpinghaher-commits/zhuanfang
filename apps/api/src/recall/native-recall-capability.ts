import { hasNativeRecall, type NativeRecallPort } from "./native-recall-port";

/**
 * P2b 注入矩阵:按权威库探测原生召回能力。
 * - `surreal` 模式:repo 自身是 SurrealRepoHandle → 直接返回。
 * - `dual-surreal` 模式:repo 是 DualWriteRepository 且 authoritative 是 surreal → 返回委托 authoritative 的端口(只读,不碰 shadow)。
 * - `dual`(auth=sqlite)/ `sqlite` / 默认:无原生能力 → undefined,召回走域层纯函数回落。
 */
export function asNativeRecall(repo: unknown): NativeRecallPort | undefined {
  if (hasNativeRecall(repo)) return repo;
  const auth = (repo as { getAuthoritative?: () => unknown } | null)?.getAuthoritative?.();
  if (hasNativeRecall(auth)) return auth;
  return undefined;
}
