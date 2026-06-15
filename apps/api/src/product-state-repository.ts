import { createInitialProductState, createEmptyProductState } from "../../../src/domain/engine";
import type { ProductState, InterviewSession } from "../../../src/domain/types";

export interface ProductStateRepository {
  getState(): ProductState;
  resetState(): ProductState;
  replaceState(state: ProductState): ProductState;
  getInterviewSession(id: string): InterviewSession | null;
}

export function createInMemoryProductStateRepository(initialState: ProductState = createInitialProductState()): ProductStateRepository {
  let state = initialState;

  return {
    getState() {
      return state;
    },
    resetState() {
      state = createEmptyProductState();
      return state;
    },
    replaceState(nextState) {
      // Server-authoritative: bump from the stored revision, not the incoming state's revision.
      const next = { ...nextState, revision: (state.revision ?? 0) + 1 };
      state = next;
      return state;
    },
    getInterviewSession(id) {
      return state.sessions.find(s => s.id === id) ?? null;
    }
  };
}
