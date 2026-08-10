/**
 * PR-S3 · request-scoped cold layer facades (SIC+ KD5/KD6).
 *
 * raw / audio / knowledge resolve to the same userKey as hot ProductState via
 * UserStoresRegistry + ALS principal. Machine tokens map to legacy (KD18).
 *
 * Sync requireReady is used after the request pin hook has acquired the store.
 * If a method is invoked without pin (and store not seeded), it fails closed
 * rather than falling back to a shared process-level singleton.
 */
import type { RawMaterialRepository } from "../raw-material-repository";
import type { AudioRepository } from "../audio-repository";
import type { KnowledgeIndexRepository } from "../knowledge-index-repository";
import { currentPrincipal, legacyOwner } from "./user-context";
import { resolveStoreUserKey, type UserStoresRegistry } from "./user-stores-registry";

function resolveKey(
  registry: UserStoresRegistry,
  env: Record<string, string | undefined>,
  fallbackUsername?: string
): string {
  return resolveStoreUserKey(
    env,
    currentPrincipal(),
    fallbackUsername ?? legacyOwner(env)
  );
}

/** Proxy that re-resolves the live cold repo per access (pin + ALS). */
function scopedColdProxy<T extends object>(resolve: () => T): T {
  const core = {} as T;
  return new Proxy(core, {
    get(_target, prop, _receiver) {
      const repo = resolve();
      const value = (repo as Record<string | symbol, unknown>)[prop as string];
      if (typeof value === "function") {
        return (value as (...args: unknown[]) => unknown).bind(repo);
      }
      return value;
    },
    has(_target, prop) {
      return prop in resolve();
    }
  });
}

export function createUserScopedRawMaterialRepository(options: {
  registry: UserStoresRegistry;
  env?: Record<string, string | undefined>;
  fallbackUsername?: string;
}): RawMaterialRepository {
  const env = options.env ?? process.env;
  return scopedColdProxy(() => {
    const key = resolveKey(options.registry, env, options.fallbackUsername);
    return options.registry.requireReady(key).rawMaterial;
  });
}

export function createUserScopedAudioRepository(options: {
  registry: UserStoresRegistry;
  env?: Record<string, string | undefined>;
  fallbackUsername?: string;
}): AudioRepository {
  const env = options.env ?? process.env;
  return scopedColdProxy(() => {
    const key = resolveKey(options.registry, env, options.fallbackUsername);
    return options.registry.requireReady(key).audio;
  });
}

export function createUserScopedKnowledgeIndexRepository(options: {
  registry: UserStoresRegistry;
  env?: Record<string, string | undefined>;
  fallbackUsername?: string;
}): KnowledgeIndexRepository {
  const env = options.env ?? process.env;
  return scopedColdProxy(() => {
    const key = resolveKey(options.registry, env, options.fallbackUsername);
    return options.registry.requireReady(key).knowledgeIndex;
  });
}

export function createUserScopedColdRepos(options: {
  registry: UserStoresRegistry;
  env?: Record<string, string | undefined>;
  fallbackUsername?: string;
}): {
  rawMaterialRepository: RawMaterialRepository;
  audioRepository: AudioRepository;
  knowledgeIndexRepository: KnowledgeIndexRepository;
} {
  return {
    rawMaterialRepository: createUserScopedRawMaterialRepository(options),
    audioRepository: createUserScopedAudioRepository(options),
    knowledgeIndexRepository: createUserScopedKnowledgeIndexRepository(options)
  };
}
