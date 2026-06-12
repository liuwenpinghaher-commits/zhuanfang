import { createInitialProductState } from "../../../src/domain/engine";
import type { ProductState } from "../../../src/domain/types";

export interface ProductStateRepository {
  getState(): ProductState;
  resetState(): ProductState;
  replaceState(state: ProductState): ProductState;
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
    }
  };
}
