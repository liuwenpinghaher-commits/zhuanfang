import type { ProductState } from "../../../src/domain/types";
import { buildStableDigest } from "../../../src/domain/stateDigest";
import type { ProductStateRepository, ReplaceStateOptions } from "./product-state-repository";

export interface DualWriteOptions {
  /** 权威库:读/乐观锁/revision/返回值的来源。 */
  authoritative: ProductStateRepository;
  /** 影子库:镜像所有写;其错误与发散不影响主写。 */
  shadow: ProductStateRepository;
  /** 影子内容与权威不一致时回调(默认结构化告警,不抛)。 */
  onDivergence?: (info: { op: string; authDigest: string; shadowDigest: string; firstDiffKey?: string }) => void;
  /** 影子写抛错时回调(默认结构化告警,不抛)。 */
  onShadowError?: (err: unknown, op: string) => void;
}

/** 内容比对忽略的存储层元字段(非业务内容)。 */
const IGNORED_DIGEST_KEYS = new Set<string>(["revision", "schemaVersion"]);

/**
 * 内容等价签名:排序键 + 忽略存储层元字段。
 * - revision:两库各自 bump,不代表内容差异。
 * - schemaVersion:两个持久库(sqlite+surreal)均由 normalizeProductState 无条件注入=2、恒等;
 *   in-memory 不注入。均属存储层元信息,非业务内容,zero 掉以免干扰内容比对。
 */
function contentDigest(state: ProductState): string {
  return buildStableDigest({ ...state, revision: 0, schemaVersion: 0 });
}

/** 首个不等的顶层键(诊断用)。从两边 state 的键全集并集派生,忽略元字段——
 *  避免手维子集漏 key(如 auditEvents/aiRunEvents 等高频数组)导致发散却报 firstDiffKey:undefined 误导排查。 */
function firstDivergentKey(a: ProductState, b: ProductState): string | undefined {
  const ra = a as unknown as Record<string, unknown>;
  const rb = b as unknown as Record<string, unknown>;
  for (const k of new Set([...Object.keys(ra), ...Object.keys(rb)])) {
    if (IGNORED_DIGEST_KEYS.has(k)) continue;
    if (buildStableDigest(ra[k]) !== buildStableDigest(rb[k])) return k;
  }
  return undefined;
}

// 发散/影子写失败级别为 error:dual-surreal 模式下影子是回退路径(sqlite 冷备),失败不应被淹没。
const defaultOnDivergence: NonNullable<DualWriteOptions["onDivergence"]> = (info) =>
  console.error(JSON.stringify({ event: "dual_write_divergence", ...info }));
const defaultOnShadowError: NonNullable<DualWriteOptions["onShadowError"]> = (err, op) =>
  console.error(JSON.stringify({ event: "dual_write_shadow_error", op, error: String(err) }));

/** 双写仓库:读走 authoritative,写双落 + 影子读等价比对。shadow 的错误/发散绝不破坏主写。 */
export function createDualWriteRepository(opts: DualWriteOptions): ProductStateRepository {
  const { authoritative, shadow } = opts;
  const onDivergence = opts.onDivergence ?? defaultOnDivergence;
  const onShadowError = opts.onShadowError ?? defaultOnShadowError;

  // 回调再包一层 try/catch:即便调用方注入的回调自身抛错,也绝不冒泡破坏主写(权威写已落定)。
  const reportDivergence = (info: Parameters<NonNullable<DualWriteOptions["onDivergence"]>>[0]) => {
    try { onDivergence(info); } catch { /* 注入回调抛错也不破坏主写 */ }
  };
  const reportShadowError = (err: unknown, op: string) => {
    try { onShadowError(err, op); } catch { /* 同上 */ }
  };

  function mirrorAndCompare(op: "reset" | "replace", next: ProductState) {
    // 影子写不带 expectedRevision(只镜像内容,不参与乐观锁);错误吞掉只告警。
    try {
      if (op === "reset") shadow.resetState();
      else shadow.replaceState(next);
    } catch (err) {
      reportShadowError(err, op);
      return;
    }
    try {
      const authState = authoritative.getState();
      const shadowState = shadow.getState();
      if (contentDigest(authState) !== contentDigest(shadowState)) {
        reportDivergence({
          op,
          authDigest: contentDigest(authState),
          shadowDigest: contentDigest(shadowState),
          firstDiffKey: firstDivergentKey(authState, shadowState)
        });
      }
    } catch (err) {
      reportShadowError(err, `${op}:compare`);
    }
  }

  return {
    getState: () => authoritative.getState(),
    getInterviewSession: (id) => authoritative.getInterviewSession(id),
    resetState() {
      const result = authoritative.resetState();
      mirrorAndCompare("reset", result);
      return result;
    },
    replaceState(next: ProductState, replaceOpts?: ReplaceStateOptions) {
      // 权威先写(乐观锁在此判定,冲突会抛——这是期望行为,主路径语义不变)。
      const result = authoritative.replaceState(next, replaceOpts);
      // 影子镜像权威写出的结果(已 bump revision),再比对。
      mirrorAndCompare("replace", result);
      return result;
    }
  };
}
