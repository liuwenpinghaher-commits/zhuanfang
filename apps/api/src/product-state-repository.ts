import { createInitialProductState } from "../../../src/domain/engine";
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
      state = createInitialProductState();
      return state;
    },
    replaceState(nextState) {
      state = nextState;
      return state;
    },
    getInterviewSession(id) {
      return state.sessions.find(s => s.id === id) ?? null;
    }
  };
}
