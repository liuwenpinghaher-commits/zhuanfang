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
 * 审计修复(F-01/A1):导出给 dual-surreal-cutover 的启动期权威库检查复用——两处必须是同一份
 * 摘要口径(同一 IGNORED 集合),否则"启动期判等"与"运行期发散比对"会各说各话。
 */
export function contentDigest(state: ProductState): string {
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
export function createDualWriteRepository(opts: DualWriteOptions): ProductStateRepository & { getAuthoritative(): ProductStateRepository; getPersistHealth(): { consecutiveFailures: number; lastError?: string; lastErrorAt?: string; shadowFailures?: number } } {
  const { authoritative, shadow } = opts;
  const onDivergence = opts.onDivergence ?? defaultOnDivergence;
  const onShadowError = opts.onShadowError ?? defaultOnShadowError;

  // 回调再包一层 try/catch:即便调用方注入的回调自身抛错,也绝不冒泡破坏主写(权威写已落定)。
  const reportDivergence = (info: Parameters<NonNullable<DualWriteOptions["onDivergence"]>>[0]) => {
    try { onDivergence(info); } catch { /* 注入回调抛错也不破坏主写 */ }
  };
  // 审计修复(P3-35 + 回归审查 R6-1/R6-2/R6-3):影子库(dual-surreal 下 sqlite 冷备,回退路径)不健康
  // 此前只进 console,/api/health 全绿 → 真需回退时才发现冷备落后。经 getPersistHealth 暴露。
  // R6-2:改累计为**连续**计数——每次影子写成功且无发散即清零,一次瞬时异常(SQLITE_BUSY)不再永久
  //       degraded(与权威侧 consecutiveFailures 语义对齐,名副其实)。
  // R6-1:发散(影子写成功但内容偏离权威=冷备落后,fix 注释点名的主场景)也计入,不只数抛错异常。
  // R6-3:记 lastShadowErrorAt。
  let shadowConsecutiveFailures = 0;
  let lastShadowError: string | undefined;
  let lastShadowErrorAt: string | undefined;
  const recordShadowUnhealthy = (msg: string, err?: unknown, op?: string) => {
    shadowConsecutiveFailures += 1;
    lastShadowError = msg;
    lastShadowErrorAt = new Date().toISOString();
    if (err !== undefined && op !== undefined) {
      try { onShadowError(err, op); } catch { /* 注入回调抛错也不破坏主写 */ }
    }
  };

  function mirrorAndCompare(op: "reset" | "replace", next: ProductState) {
    // 影子写不带 expectedRevision(只镜像内容,不参与乐观锁);错误吞掉只告警。
    try {
      if (op === "reset") shadow.resetState();
      else shadow.replaceState(next);
    } catch (err) {
      recordShadowUnhealthy(`${op}: ${err instanceof Error ? err.message : String(err)}`, err, op);
      return;
    }
    try {
      const authState = authoritative.getState();
      const shadowState = shadow.getState();
      if (contentDigest(authState) !== contentDigest(shadowState)) {
        // R6-1:发散计入不健康(影子写进了但内容≠权威 → 冷备已漂移)。
        const firstDiffKey = firstDivergentKey(authState, shadowState);
        recordShadowUnhealthy(`${op}:divergence firstDiffKey=${firstDiffKey}`);
        reportDivergence({
          op,
          authDigest: contentDigest(authState),
          shadowDigest: contentDigest(shadowState),
          firstDiffKey
        });
        return;
      }
    } catch (err) {
      recordShadowUnhealthy(`${op}:compare: ${err instanceof Error ? err.message : String(err)}`, err, `${op}:compare`);
      return;
    }
    // R6-2:影子写成功 且 内容与权威一致 → 影子健康,连续失败清零。
    shadowConsecutiveFailures = 0;
  }

  return {
    getState: () => authoritative.getState(),
    /** P2b:暴露权威库供原生召回能力探测(asNativeRecall);只读,不影响双写语义。 */
    getAuthoritative: () => authoritative,
    /** 审计修复(P3-35 + R6):落库健康度 = 权威库自身(若为 surreal 有 getPersistHealth)+ 影子连续
     *  失败(写异常+发散)。server 的 probePersistHealth 经此拿到影子腐化信号,/api/health 得以暴露。 */
    getPersistHealth() {
      const authHealth = (authoritative as { getPersistHealth?: () => { consecutiveFailures: number; lastError?: string; lastErrorAt?: string } }).getPersistHealth?.();
      const authFailures = authHealth?.consecutiveFailures ?? 0;
      return {
        consecutiveFailures: authFailures + shadowConsecutiveFailures,
        ...(authHealth?.lastError || lastShadowError ? { lastError: authHealth?.lastError ?? lastShadowError } : {}),
        // R6-3:补回 lastErrorAt(此前 dual repo 有 getPersistHealth 后 ?? 短路到它却不带该字段,health 恒缺失)。
        ...(authHealth?.lastErrorAt || lastShadowErrorAt ? { lastErrorAt: authHealth?.lastErrorAt ?? lastShadowErrorAt } : {}),
        ...(shadowConsecutiveFailures > 0 ? { shadowFailures: shadowConsecutiveFailures } : {})
      };
    },
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
