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
   * 仅 withKnowledgeReindex 读取;底层 sqlite/surreal/dual repo 忽略此字段。
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
