import type { InterviewSession, ProductState } from "../../../../src/domain/types";
import {
  createInMemoryProductStateRepository,
  type ProductStateRepository,
  type ReplaceStateOptions
} from "../product-state-repository";
import { currentPrincipal, currentUsername, legacyOwner, sanitizeUserKey } from "./user-context";
import { resolveStoreUserKey, type UserStoresRegistry } from "./user-stores-registry";

/**
 * Optional Surreal capabilities that scoped adapters must forward (SIC+ KD17).
 * Not on the base ProductStateRepository interface so memory repos stay lean;
 * production Surreal handles implement them.
 */
export type ProductStateRepoCapabilities = ProductStateRepository & {
  getPersistHealth?: () => {
    consecutiveFailures: number;
    lastError?: string;
    lastErrorAt?: string;
  };
  auditGraphConsistency?: () => Promise<unknown>;
  runGovernanceTransaction?: (...args: unknown[]) => Promise<ProductState>;
  flush?: () => Promise<void>;
  confirmPersisted?: () => Promise<void>;
  getGovernanceGeneration?: () => number;
};

/**
 * Build a ProductState facade that always resolves the current user's repo, and
 * **forwards optional capabilities** via Proxy so `in` / typeof probes match the
 * underlying handle (KD17). Explicit core methods keep replace/get semantics clear.
 */
function createScopedProductStateFacade(
  resolve: () => ProductStateRepoCapabilities
): ProductStateRepoCapabilities {
  const core: ProductStateRepository = {
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

  return new Proxy(core as ProductStateRepoCapabilities, {
    get(target, prop, receiver) {
      if (prop in target) {
        return Reflect.get(target, prop, receiver);
      }
      // Capability forward: bind methods to the live underlying repo (not the proxy).
      const repo = resolve();
      const value = (repo as unknown as Record<string | symbol, unknown>)[prop as string];
      if (typeof value === "function") {
        return (value as (...args: unknown[]) => unknown).bind(repo);
      }
      return value;
    },
    has(target, prop) {
      if (prop in target) return true;
      return prop in resolve();
    }
  });
}

/**
 * Request-scoped multi-user ProductState isolation (P1 / PR-S3).
 * Delegates get/replace (and optional Surreal capabilities) to a per-user repository.
 *
 * Store key resolution uses machine → legacy (KD18) when looking up via principal.
 */
export function createUserScopedProductStateRepository(options: {
  getOrCreate: (username: string) => ProductStateRepository;
  /** When no principal is set (auth off / tests), use this key. */
  fallbackUsername?: string;
  env?: Record<string, string | undefined>;
}): ProductStateRepoCapabilities {
  const env = options.env ?? process.env;
  const fallback = options.fallbackUsername ?? legacyOwner(env);

  const resolve = (): ProductStateRepoCapabilities => {
    // Machine → legacy owner username so map keys align with seed (KD18).
    const principal = currentPrincipal();
    const lookup =
      principal?.kind === "user"
        ? principal.username
        : principal?.kind === "machine"
          ? legacyOwner(env)
          : (currentUsername() ?? fallback);
    return options.getOrCreate(lookup) as ProductStateRepoCapabilities;
  };

  return createScopedProductStateFacade(resolve);
}

/**
 * Durable registry-backed ProductState facade.
 * Requires the request pin hook (registry.acquire) so requireReady is sync-safe
 * (legacy is seeded sticky and always ready for background jobs).
 */
export function createRegistryUserScopedProductStateRepository(options: {
  registry: UserStoresRegistry;
  fallbackUsername?: string;
  env?: Record<string, string | undefined>;
}): ProductStateRepoCapabilities {
  const env = options.env ?? process.env;
  const fallback = options.fallbackUsername ?? legacyOwner(env);

  const resolve = (): ProductStateRepoCapabilities => {
    const key = resolveStoreUserKey(env, currentPrincipal(), fallback);
    return options.registry.requireReady(key).productState as ProductStateRepoCapabilities;
  };

  return createScopedProductStateFacade(resolve);
}

/** In-memory multi-user map factory (tests + non-production lightweight deploys only). */
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
