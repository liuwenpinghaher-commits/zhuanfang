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
}

export function createInMemoryProductStateRepository(initialState: ProductState = createInitialProductState()): ProductStateRepository {
  let state = initialState;

  return {
    getState() {
      // P1-15: return a deep clone so callers can't mutate the repository's live
      // state in place — matches the SQLite repo, which always hands back a fresh
      // snapshot. Without this, an in-memory test would silently pass on a
      // mutate-then-read bug that fails against the real (SQLite) store.
      return cloneState(state);
    },
    resetState() {
      state = createEmptyProductState();
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
