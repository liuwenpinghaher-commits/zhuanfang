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

const DIFF_KEYS: Array<keyof ProductState> = [
  "points","decisions","debts","questions","themes","notes","memoryRecords",
  "memoryCandidates","importSources","ragChunks","searchBriefs","sessions",
  "memoryEdges","chatSessions","profile","systemConfig"
];

/** 内容等价签名:排序键 + 忽略 revision(两库 revision 各自 bump)。 */
function contentDigest(state: ProductState): string {
  return buildStableDigest({ ...state, revision: 0 });
}

function firstDivergentKey(a: ProductState, b: ProductState): string | undefined {
  for (const k of DIFF_KEYS) {
    if (buildStableDigest(a[k]) !== buildStableDigest(b[k])) return String(k);
  }
  return undefined;
}

const defaultOnDivergence: NonNullable<DualWriteOptions["onDivergence"]> = (info) =>
  console.warn(JSON.stringify({ event: "dual_write_divergence", ...info }));
const defaultOnShadowError: NonNullable<DualWriteOptions["onShadowError"]> = (err, op) =>
  console.warn(JSON.stringify({ event: "dual_write_shadow_error", op, error: String(err) }));

/** 双写仓库:读走 authoritative,写双落 + 影子读等价比对。shadow 的错误/发散绝不破坏主写。 */
export function createDualWriteRepository(opts: DualWriteOptions): ProductStateRepository {
  const { authoritative, shadow } = opts;
  const onDivergence = opts.onDivergence ?? defaultOnDivergence;
  const onShadowError = opts.onShadowError ?? defaultOnShadowError;

  function mirrorAndCompare(op: string, next: ProductState) {
    // 影子写不带 expectedRevision(只镜像内容,不参与乐观锁);错误吞掉只告警。
    try {
      if (op === "reset") shadow.resetState();
      else shadow.replaceState(next);
    } catch (err) {
      onShadowError(err, op);
      return;
    }
    try {
      const authState = authoritative.getState();
      const shadowState = shadow.getState();
      if (contentDigest(authState) !== contentDigest(shadowState)) {
        onDivergence({
          op,
          authDigest: contentDigest(authState),
          shadowDigest: contentDigest(shadowState),
          firstDiffKey: firstDivergentKey(authState, shadowState)
        });
      }
    } catch (err) {
      onShadowError(err, `${op}:compare`);
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
