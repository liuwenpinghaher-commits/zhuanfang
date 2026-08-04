import type { InterviewSession, ProductState } from "../../../../src/domain/types";
import {
  createInMemoryProductStateRepository,
  type ProductStateRepository,
  type ReplaceStateOptions
} from "../product-state-repository";
import { currentUsername, legacyOwner, sanitizeUserKey } from "./user-context";

/**
 * Request-scoped multi-user ProductState isolation (P1).
 * Delegates get/replace to a per-username repository from a factory.
 */
export function createUserScopedProductStateRepository(options: {
  getOrCreate: (username: string) => ProductStateRepository;
  /** When no principal is set (auth off / tests), use this key. */
  fallbackUsername?: string;
  env?: Record<string, string | undefined>;
}): ProductStateRepository {
  const env = options.env ?? process.env;
  const fallback = options.fallbackUsername ?? legacyOwner(env);

  const resolve = (): ProductStateRepository => {
    const u = currentUsername() ?? fallback;
    return options.getOrCreate(u);
  };

  return {
    getState() {
      return resolve().getState();
    },
    resetState() {
      return resolve().resetState();
    },
    replaceState(state: ProductState, opts?: ReplaceStateOptions) {
      return resolve().replaceState(state, opts);
    },
    getInterviewSession(id: string): InterviewSession | null {
      return resolve().getInterviewSession(id);
    },
    getGovernanceGeneration() {
      return resolve().getGovernanceGeneration?.() ?? 0;
    },
    confirmPersisted() {
      return resolve().confirmPersisted?.() ?? Promise.resolve();
    }
  };
}

/** In-memory multi-user map factory (tests + lightweight deploys). */
export function createInMemoryUserRepoFactory(): {
  getOrCreate: (username: string) => ProductStateRepository;
  /** Test helper: peek another user's state without ALS */
  peek: (username: string) => ProductStateRepository | undefined;
  keys: () => string[];
} {
  const map = new Map<string, ProductStateRepository>();
  return {
    getOrCreate(username: string) {
      const key = sanitizeUserKey(username);
      let repo = map.get(key);
      if (!repo) {
        repo = createInMemoryProductStateRepository();
        map.set(key, repo);
      }
      return repo;
    },
    peek(username: string) {
      return map.get(sanitizeUserKey(username));
    },
    keys() {
      return [...map.keys()];
    }
  };
}
