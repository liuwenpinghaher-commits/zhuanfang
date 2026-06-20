import { createInitialProductState, createEmptyProductState } from "../../../src/domain/engine";
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
      const next = { ...nextState, revision: currentRevision + 1 };
      state = next;
      return cloneState(state);
    },
    getInterviewSession(id) {
      return state.sessions.find(s => s.id === id) ?? null;
    }
  };
}
