/**
 * PR-S3 · durable per-user SurrealStores registry (SIC+ KD15/KD16/KD20).
 *
 * - per-userKey singleflight on open (concurrent miss shares one openPromise)
 * - pin/refcount per request; LRU only evicts pinCount===0
 * - never double-open same dataDir
 * - closeAll on shutdown (waits inflight, ignores pin — process exit wins)
 */
import { dirname, join } from "node:path";
import type { ProductStateRepository } from "../product-state-repository";
import type { RawMaterialRepository } from "../raw-material-repository";
import type { AudioRepository } from "../audio-repository";
import type { KnowledgeIndexRepository } from "../knowledge-index-repository";
import {
  currentPrincipal,
  legacyOwner,
  sanitizeUserKey,
  type AuthPrincipal
} from "./user-context";

/** Minimal handle matching createSurrealStores return shape. */
export interface UserStoreHandle {
  productState: ProductStateRepository;
  rawMaterial: RawMaterialRepository;
  audio: AudioRepository;
  knowledgeIndex: KnowledgeIndexRepository;
  close(): Promise<void>;
}

export type OpenUserStoresFn = (args: {
  userKey: string;
  dataDir: string;
  url: string;
}) => Promise<UserStoreHandle>;

export interface UserStoresRegistryOptions {
  /** Open a full SurrealStores for the given user dataDir (must not be double-opened). */
  openStores: OpenUserStoresFn;
  /** Absolute parent of product state db (dirname(PRODUCT_STATE_DB_PATH)). */
  baseDataDir: string;
  /** Sanitized legacy owner key — uses existing …/surreal layout. */
  legacyUserKey: string;
  /** Max simultaneously open stores (default 4). */
  maxOpen?: number;
  /** Optional logger for structured events. */
  log?: (event: Record<string, unknown>) => void;
}

interface OpenedEntry {
  stores: UserStoreHandle;
  pinCount: number;
  lastUsed: number;
  dataDir: string;
  /** When true, LRU never selects this entry (legacy pre-open at startServer). */
  sticky?: boolean;
}

export interface PersistHealthLite {
  consecutiveFailures: number;
  lastError?: string;
  lastErrorAt?: string;
}

/**
 * Resolve which store key a request should use.
 * KD18: machine principal always maps to the legacy store (never a private machine dir).
 */
export function resolveStoreUserKey(
  env: Record<string, string | undefined> = process.env,
  principal: AuthPrincipal | null = currentPrincipal(),
  fallbackUsername?: string
): string {
  if (principal?.kind === "machine") {
    return sanitizeUserKey(legacyOwner(env));
  }
  const name =
    principal?.kind === "user"
      ? principal.username
      : (fallbackUsername ?? legacyOwner(env));
  return sanitizeUserKey(name);
}

/** Filesystem dataDir for a userKey (without the trailing /surreal file segment). */
export function resolveUserStoreDataDir(
  baseDataDir: string,
  userKey: string,
  legacyUserKey: string
): string {
  const key = sanitizeUserKey(userKey);
  const legacy = sanitizeUserKey(legacyUserKey);
  if (key === legacy) {
    return join(baseDataDir, "surreal");
  }
  return join(baseDataDir, "users", `user_${key}`, "surreal");
}

export function userStoreUrl(dataDir: string): string {
  return `surrealkv://${dataDir}/surreal`;
}

export function isUserScopedStateEnabled(
  env: Record<string, string | undefined> = process.env
): boolean {
  return ["1", "true", "yes", "on"].includes(
    (env.PRODUCT_USER_SCOPED_STATE ?? "").trim().toLowerCase()
  );
}

export function userStoreLruMax(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.PRODUCT_USER_STORE_LRU_MAX);
  if (Number.isFinite(n) && n >= 1) return Math.floor(n);
  return 4;
}

/**
 * KD16: production + USER_SCOPED=1 requires a durable Surreal factory/registry.
 * Throws so startServer / buildApiServer refuse to run memory multi-tenant.
 */
export function assertDurableUserScopedOrThrow(
  env: Record<string, string | undefined>,
  opts: { durable: boolean; productStoreMode?: string }
): void {
  if (!isUserScopedStateEnabled(env)) return;
  const production =
    (env.DEPLOYMENT_PROFILE ?? "").trim().toLowerCase() === "production";
  if (!production) return;
  if (!opts.durable || opts.productStoreMode === "memory") {
    throw new Error(
      "PRODUCT_USER_SCOPED_STATE=1 under DEPLOYMENT_PROFILE=production requires durable Surreal user stores " +
        "(PRODUCT_STORE=surreal + UserStoresRegistry). In-memory multi-user factory is forbidden (SIC+ KD16)."
    );
  }
}

export class UserStoresRegistry {
  private readonly ready = new Map<string, OpenedEntry>();
  private readonly opening = new Map<string, Promise<UserStoreHandle>>();
  private readonly openStores: OpenUserStoresFn;
  private readonly baseDataDir: string;
  private readonly legacyUserKey: string;
  private readonly maxOpen: number;
  private readonly log: (event: Record<string, unknown>) => void;
  private closingAll = false;

  constructor(options: UserStoresRegistryOptions) {
    this.openStores = options.openStores;
    this.baseDataDir = options.baseDataDir;
    this.legacyUserKey = sanitizeUserKey(options.legacyUserKey);
    this.maxOpen = Math.max(1, options.maxOpen ?? 4);
    this.log =
      options.log ??
      ((event) => {
        try {
          console.info(JSON.stringify(event));
        } catch {
          /* */
        }
      });
  }

  get legacyKey(): string {
    return this.legacyUserKey;
  }

  /** Keys currently open (ready map). */
  openKeys(): string[] {
    return [...this.ready.keys()];
  }

  dataDirFor(userKey: string): string {
    return resolveUserStoreDataDir(this.baseDataDir, userKey, this.legacyUserKey);
  }

  /**
   * Seed an already-opened handle (e.g. legacy pre-open at startServer) without pin.
   * Never double-seed the same key. Seeded entries are sticky (not LRU-evicted) so
   * background jobs and health always have a live legacy handle.
   */
  seed(userKey: string, stores: UserStoreHandle, opts?: { sticky?: boolean }): void {
    const key = sanitizeUserKey(userKey);
    if (this.ready.has(key) || this.opening.has(key)) {
      throw new Error(`UserStoresRegistry.seed: ${key} already open or opening`);
    }
    this.ready.set(key, {
      stores,
      pinCount: 0,
      lastUsed: Date.now(),
      dataDir: this.dataDirFor(key),
      sticky: opts?.sticky ?? key === this.legacyUserKey
    });
  }

  getIfReady(userKey: string): UserStoreHandle | undefined {
    return this.ready.get(sanitizeUserKey(userKey))?.stores;
  }

  /**
   * Sync access after acquire/pin (or seed). Throws if store is not ready —
   * ProductState facades are sync and require the onRequest pin hook.
   */
  requireReady(userKey: string): UserStoreHandle {
    const key = sanitizeUserKey(userKey);
    const entry = this.ready.get(key);
    if (!entry) {
      throw new Error(
        `User store not ready for key=${key}; ensure request pin/acquire ran first`
      );
    }
    entry.lastUsed = Date.now();
    return entry.stores;
  }

  /**
   * Resolve + pin. Concurrent callers for the same key share one openPromise (singleflight).
   * LRU eviction runs only for pinCount===0 entries when capacity is exceeded.
   */
  async acquire(userKey: string): Promise<UserStoreHandle> {
    if (this.closingAll) {
      throw new Error("UserStoresRegistry is shutting down");
    }
    const key = sanitizeUserKey(userKey);
    const opened = this.ready.get(key);
    if (opened) {
      opened.pinCount += 1;
      opened.lastUsed = Date.now();
      return opened.stores;
    }

    let inflight = this.opening.get(key);
    if (!inflight) {
      inflight = this.openOne(key).finally(() => {
        this.opening.delete(key);
      });
      this.opening.set(key, inflight);
    }
    const stores = await inflight;
    const entry = this.ready.get(key);
    if (!entry) {
      // open failed and cleaned up — surface as unavailable
      throw new Error(`User store open failed for key=${key}`);
    }
    entry.pinCount += 1;
    entry.lastUsed = Date.now();
    return stores;
  }

  release(userKey: string): void {
    const key = sanitizeUserKey(userKey);
    const entry = this.ready.get(key);
    if (!entry) return;
    if (entry.pinCount > 0) entry.pinCount -= 1;
  }

  /**
   * Aggregate persist health across legacy + currently open stores (max failures).
   * Unopened user dirs are not scanned (acceptable; avoid start-time full disk walk).
   */
  aggregatePersistHealth(): PersistHealthLite | undefined {
    let max = 0;
    let lastError: string | undefined;
    let lastErrorAt: string | undefined;
    let any = false;
    for (const entry of this.ready.values()) {
      const ph = (
        entry.stores.productState as {
          getPersistHealth?: () => PersistHealthLite;
        }
      ).getPersistHealth?.();
      if (!ph) continue;
      any = true;
      if (ph.consecutiveFailures >= max) {
        max = ph.consecutiveFailures;
        if (ph.lastError) lastError = ph.lastError;
        if (ph.lastErrorAt) lastErrorAt = ph.lastErrorAt;
      }
    }
    if (!any) return undefined;
    return { consecutiveFailures: max, lastError, lastErrorAt };
  }

  /**
   * Shutdown: wait for inflight opens, then close every ready store (ignore pin).
   * Serial closes to avoid thundering herd on process exit.
   */
  async closeAll(): Promise<void> {
    this.closingAll = true;
    const inflight = [...this.opening.values()];
    if (inflight.length > 0) {
      await Promise.allSettled(inflight);
    }
    const entries = [...this.ready.entries()];
    this.ready.clear();
    this.opening.clear();
    for (const [key, entry] of entries) {
      try {
        await entry.stores.close();
        this.log({ event: "user_store_close", userKey: key, reason: "closeAll" });
      } catch (error) {
        this.log({
          event: "user_store_close_failed",
          userKey: key,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }

  /** Test helper: pin count for a key (0 if not open). */
  pinCountOf(userKey: string): number {
    return this.ready.get(sanitizeUserKey(userKey))?.pinCount ?? 0;
  }

  private async openOne(key: string): Promise<UserStoreHandle> {
    await this.maybeEvict();
    const dataDir = this.dataDirFor(key);
    // Guard: never open a dataDir that is already open under another key
    for (const [otherKey, entry] of this.ready) {
      if (entry.dataDir === dataDir) {
        throw new Error(
          `Refusing double-open of dataDir=${dataDir} (already open as userKey=${otherKey})`
        );
      }
    }
    const url = userStoreUrl(dataDir);
    this.log({ event: "user_store_open_start", userKey: key, dataDir, url });
    try {
      const stores = await this.openStores({ userKey: key, dataDir, url });
      this.ready.set(key, {
        stores,
        pinCount: 0,
        lastUsed: Date.now(),
        dataDir
      });
      this.log({ event: "user_store_open_ok", userKey: key, dataDir });
      return stores;
    } catch (error) {
      this.log({
        event: "user_store_open_failed",
        userKey: key,
        dataDir,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  private async maybeEvict(): Promise<void> {
    while (this.ready.size >= this.maxOpen) {
      let victimKey: string | undefined;
      let victimLast = Infinity;
      for (const [key, entry] of this.ready) {
        if (entry.pinCount !== 0) continue;
        if (entry.sticky) continue;
        if (this.opening.has(key)) continue;
        if (entry.lastUsed < victimLast) {
          victimLast = entry.lastUsed;
          victimKey = key;
        }
      }
      if (!victimKey) {
        // All pinned — cannot open another until a release; open will still proceed
        // past maxOpen only if nothing is evictable (bounded by concurrent pins).
        this.log({
          event: "user_store_lru_skip",
          reason: "all_pinned",
          open: this.ready.size,
          maxOpen: this.maxOpen
        });
        return;
      }
      const entry = this.ready.get(victimKey);
      if (!entry) return;
      this.ready.delete(victimKey);
      try {
        await entry.stores.close();
        this.log({
          event: "user_store_evict",
          userKey: victimKey,
          dataDir: entry.dataDir
        });
      } catch (error) {
        this.log({
          event: "user_store_evict_close_failed",
          userKey: victimKey,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }
}

export function createUserStoresRegistry(
  options: UserStoresRegistryOptions
): UserStoresRegistry {
  return new UserStoresRegistry(options);
}

/** Helper used by startServer to build baseDataDir from PRODUCT_STATE_DB_PATH. */
export function baseDataDirFromProductStateDbPath(productStateDbPath: string): string {
  return dirname(productStateDbPath);
}
