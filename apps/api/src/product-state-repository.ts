import { createInitialProductState, createEmptyProductState } from "../../../src/domain/engine";
import { normalizeProductState } from "../../../src/domain/storage";
import { cloneState } from "../../../src/domain/utils";
import type { ProductState, InterviewSession } from "../../../src/domain/types";

/**
 * P1-14: thrown by replaceState when an optimistic-concurrency check fails — the
 * caller supplied `expectedRevision` but the persisted state has already advanced
 * past it (a concurrent write won the race). Carries the current persisted revision
 * so the caller can surface a 409 with the authoritative state. Identifiable via
 * `instanceof` / the `name` field so a route can distinguish it from other errors.
 */
export class StateRevisionConflictError extends Error {
  constructor(public readonly expectedRevision: number, public readonly actualRevision: number) {
    super(`State revision conflict: expected ${expectedRevision}, found ${actualRevision}`);
    this.name = "StateRevisionConflictError";
  }
}

/**
 * R2b(M1 修复):治理事务(reset/purge/import)在途时,任何并发整状态写(replaceState/resetState)
 * 被拒——防止并发写读到"尚未清空的旧 state"、快照后排到治理之后、以治理推进的新基线把个人行 UPSERT
 * 回权威库(purge/reset 后数据复活)。`statusCode = 409` 让 server.ts 全局错误处理器自动映射成 409
 * (HTTP 写方前端已有 409 重试;后台写方 scheduler/knowledge-reembed 已有 try/catch → 记日志跳过、
 * 下一 tick 自愈)。仅 Surreal 治理档会抛(内存/sqlite 档无治理事务,无此并发面)。
 */
export class GovernanceInFlightError extends Error {
  readonly statusCode = 409;
  constructor() {
    super("A governance operation (reset/purge/import) is in progress; retry this write after it settles.");
    this.name = "GovernanceInFlightError";
  }
}

export interface ReplaceStateOptions {
  /**
   * P1-14: optimistic-concurrency guard. When provided, replaceState throws
   * {@link StateRevisionConflictError} if the current persisted revision differs,
   * so a high-frequency write path (e.g. interview turns racing a PUT /api/state)
   * can refuse a lost-update. Omit to keep the existing last-write-wins behaviour.
   */
  expectedRevision?: number;
  /**
   * 回归审查 R4-3:跳过 withKnowledgeReindex 的增量重索引。用于 import/purge——它们随后会
   * 显式全量 rebuild/清空(含冷层逐字稿),包装层的增量 reindex 是重复嵌入(浪费预算,收敛一致但冗余)。
   * 仅 withKnowledgeReindex 读取;底层 surreal/memory repo 忽略此字段。
   */
  skipReindex?: boolean;
}

export interface ProductStateRepository {
  getState(): ProductState;
  resetState(): ProductState;
  replaceState(state: ProductState, opts?: ReplaceStateOptions): ProductState;
  getInterviewSession(id: string): InterviewSession | null;
  /**
   * N-05:治理代际——每次整库替换/清空(reset;surreal 档还含 purge/import 治理事务)递增。后台长任务
   * (auto-run 简报生成、调度器 tick)在起点捕获,终写前比对:代际已变即联网期间发生过治理,基于治理前
   * 状态生成的产出必须丢弃,否则会把含旧主题名的简报写回已清空的库(reset 后干净库冒出旧简报)。
   * 可选:仅 surreal handle 与内存档实现;缺失(=undefined)时调用方回落既有行为(向后兼容)。
   */
  getGovernanceGeneration?(): number;
  /**
   * A-18:等待最后一笔整状态写的真实落库结果,失败 reject。仅持久档(surreal)实现;
   * 内存档无持久层(该配置本身经 /api/system 以 degraded 如实暴露),缺失即无需确认。
   */
  confirmPersisted?(): Promise<void>;
}

export function createInMemoryProductStateRepository(initialState: ProductState = createInitialProductState()): ProductStateRepository {
  let state = initialState;
  // N-05:内存档的治理代际。resetState 是内存档唯一的"整库清空"入口 → 在此递增,让 auto-run/scheduler
  // 的 stale-generation 守卫在内存档也生效(surreal 档另在治理事务成功时递增,覆盖 reset/purge/import)。
  let governanceGeneration = 0;

  return {
    getState() {
      // P1-15: return a deep clone so callers can't mutate the repository's live
      // state in place — matches the SQLite repo, which always hands back a fresh
      // snapshot. Without this, an in-memory test would silently pass on a
      // mutate-then-read bug that fails against the real (SQLite) store.
      return cloneState(state);
    },
    getGovernanceGeneration() {
      return governanceGeneration;
    },
    resetState() {
      state = createEmptyProductState();
      governanceGeneration += 1;   // N-05:reset = 一次治理清空
      return cloneState(state);
    },
    replaceState(nextState, opts) {
      const currentRevision = state.revision ?? 0;
      // P1-14: optimistic-concurrency check (opt-in via expectedRevision).
      if (opts?.expectedRevision !== undefined && opts.expectedRevision !== currentRevision) {
        throw new StateRevisionConflictError(opts.expectedRevision, currentRevision);
      }
      // Server-authoritative: bump from the stored revision, not the incoming state's revision.
      // 审计修复(P3-49):写路径过 normalize,与 sqlite/surreal 生产仓库对齐——此前 in-memory
      // 原样存取,测试基底与生产行为分叉(枚举钳制/滚动窗/死键清理只在生产生效)。
      const next = normalizeProductState({ ...nextState, revision: currentRevision + 1 });
      state = next;
      return cloneState(state);
    },
    getInterviewSession(id) {
      return state.sessions.find(s => s.id === id) ?? null;
    }
  };
}

/** Await durable confirm after replaceState so fine-grained routes do not 200 before persist. */
export async function replaceStateDurable(
  repo: ProductStateRepository,
  next: ProductState,
  opts?: ReplaceStateOptions
): Promise<ProductState> {
  const state = repo.replaceState(next, opts);
  await repo.confirmPersisted?.();
  return state;
}
