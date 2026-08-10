import { describe, expect, it, vi } from "vitest";
import {
  assertDurableUserScopedOrThrow,
  createUserStoresRegistry,
  isUserScopedStateEnabled,
  resolveStoreUserKey,
  resolveUserStoreDataDir,
  type UserStoreHandle
} from "./user-stores-registry";
import { createInMemoryProductStateRepository } from "../product-state-repository";
import { createInMemoryRawMaterialRepository } from "../raw-material-repository";
import { createInMemoryAudioRepository } from "../audio-repository";
import { createInMemoryKnowledgeIndexRepository } from "../knowledge-index-repository";
import {
  createInMemoryUserRepoFactory,
  createUserScopedProductStateRepository
} from "./user-scoped-repository";
import { runWithPrincipal } from "./user-context";

function mockStores(label: string): UserStoreHandle {
  const productState = createInMemoryProductStateRepository();
  // tag for identity checks
  (productState as { __label?: string }).__label = label;
  return {
    productState,
    rawMaterial: createInMemoryRawMaterialRepository(),
    audio: createInMemoryAudioRepository(),
    knowledgeIndex: createInMemoryKnowledgeIndexRepository(),
    close: vi.fn(async () => undefined)
  };
}

describe("resolveStoreUserKey / paths", () => {
  it("maps machine principal to legacy owner (KD18)", () => {
    const env = { PRODUCT_LEGACY_OWNER: "admin" };
    expect(
      resolveStoreUserKey(env, { kind: "machine", username: "__machine__" })
    ).toBe("admin");
  });

  it("sanitizes user principal", () => {
    expect(
      resolveStoreUserKey({}, { kind: "user", username: "Alice/X" })
    ).toBe("alice_x");
  });

  it("legacy dataDir uses …/surreal; others use users/user_<key>/surreal", () => {
    expect(resolveUserStoreDataDir("/data", "admin", "admin")).toBe("/data/surreal");
    expect(resolveUserStoreDataDir("/data", "bob", "admin")).toBe(
      "/data/users/user_bob/surreal"
    );
  });
});

describe("UserStoresRegistry singleflight + pin + LRU", () => {
  it("parallel same-user acquire opens once (singleflight)", async () => {
    let openCount = 0;
    const openDelay = 30;
    const registry = createUserStoresRegistry({
      baseDataDir: "/tmp/zf-registry-test",
      legacyUserKey: "admin",
      maxOpen: 4,
      openStores: async ({ userKey }) => {
        openCount += 1;
        await new Promise((r) => setTimeout(r, openDelay));
        return mockStores(userKey);
      }
    });

    const [a, b, c] = await Promise.all([
      registry.acquire("bob"),
      registry.acquire("bob"),
      registry.acquire("bob")
    ]);
    expect(openCount).toBe(1);
    expect(a.productState).toBe(b.productState);
    expect(b.productState).toBe(c.productState);
    expect(registry.pinCountOf("bob")).toBe(3);
    registry.release("bob");
    registry.release("bob");
    registry.release("bob");
    expect(registry.pinCountOf("bob")).toBe(0);
    await registry.closeAll();
    expect(openCount).toBe(1);
  });

  it("does not evict pinned entry when LRU is full", async () => {
    const registry = createUserStoresRegistry({
      baseDataDir: "/tmp/zf-registry-lru",
      legacyUserKey: "admin",
      maxOpen: 2,
      openStores: async ({ userKey }) => mockStores(userKey)
    });

    await registry.acquire("u1");
    await registry.acquire("u2");
    // both pinned; opening u3 cannot evict them
    await registry.acquire("u3");
    expect(registry.openKeys().sort()).toEqual(["u1", "u2", "u3"].sort());
    expect(registry.pinCountOf("u1")).toBe(1);
    expect(registry.pinCountOf("u2")).toBe(1);

    registry.release("u1");
    registry.release("u2");
    // u1/u2 unpinned; next open can evict LRU
    registry.release("u3");
    await registry.acquire("u4");
    // at most maxOpen after eviction cycle, but u4 must be present
    expect(registry.getIfReady("u4")).toBeTruthy();
    await registry.closeAll();
  });

  it("seed then requireReady; never double-open seeded dataDir", async () => {
    const seeded = mockStores("legacy");
    let openCount = 0;
    const registry = createUserStoresRegistry({
      baseDataDir: "/data",
      legacyUserKey: "admin",
      openStores: async ({ userKey }) => {
        openCount += 1;
        return mockStores(userKey);
      }
    });
    registry.seed("admin", seeded);
    const got = await registry.acquire("admin");
    expect(got).toBe(seeded);
    expect(openCount).toBe(0);
    expect(registry.requireReady("admin")).toBe(seeded);
    registry.release("admin");
    await registry.closeAll();
  });

  it("closeAll closes every open store", async () => {
    const registry = createUserStoresRegistry({
      baseDataDir: "/tmp/zf-close",
      legacyUserKey: "admin",
      openStores: async ({ userKey }) => mockStores(userKey)
    });
    const a = await registry.acquire("a");
    const b = await registry.acquire("b");
    registry.release("a");
    registry.release("b");
    await registry.closeAll();
    expect(a.close).toHaveBeenCalledTimes(1);
    expect(b.close).toHaveBeenCalledTimes(1);
    expect(registry.openKeys()).toEqual([]);
  });

  it("does not double-open same dataDir while LRU close is in flight", async () => {
    const events: string[] = [];
    type Hold = { release: () => void; wait: Promise<void> };
    const holds: Hold[] = [];
    const openCounts = new Map<string, number>();
    let openWhileCloseActive = 0;
    let closeActive = 0;

    const registry = createUserStoresRegistry({
      baseDataDir: "/tmp/zf-double-open-close",
      legacyUserKey: "admin",
      maxOpen: 1,
      openStores: async ({ userKey, dataDir }) => {
        if (closeActive > 0) openWhileCloseActive += 1;
        openCounts.set(userKey, (openCounts.get(userKey) ?? 0) + 1);
        events.push(`open:${userKey}`);
        const stores = mockStores(userKey);
        let release!: () => void;
        const wait = new Promise<void>((r) => {
          release = r;
        });
        holds.push({ release, wait });
        stores.close = vi.fn(async () => {
          closeActive += 1;
          events.push(`close-start:${userKey}`);
          // Hold close open so concurrent acquire can race the window.
          await wait;
          events.push(`close-end:${userKey}`);
          closeActive -= 1;
        });
        void dataDir;
        return stores;
      }
    });

    await registry.acquire("bob");
    registry.release("bob");
    expect(openCounts.get("bob")).toBe(1);

    // Opening alice with maxOpen=1 must evict bob (async close held).
    const aliceP = registry.acquire("alice");

    // Wait until bob's close has started (ready deleted, closing registered).
    await vi.waitFor(
      () => {
        expect(events).toContain("close-start:bob");
      },
      { timeout: 2000, interval: 5 }
    );

    expect(registry.isClosingDataDir(registry.dataDirFor("bob"))).toBe(true);
    expect(registry.getIfReady("bob")).toBeUndefined();

    // Concurrent re-open of bob while close still in flight — must wait, not openStores yet.
    const bobP = registry.acquire("bob");
    // Give the event loop a turn so a buggy double-open would have started.
    await new Promise((r) => setTimeout(r, 40));
    expect(openCounts.get("bob")).toBe(1);
    expect(events.filter((e) => e === "open:bob")).toHaveLength(1);

    // Settle bob close; alice may still be waiting on maybeEvict, then open alice, then bob re-open.
    const bobHold = holds[0];
    expect(bobHold).toBeTruthy();
    bobHold!.release();

    // alice open may register its own close hold if any — release remaining holds as they appear.
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      for (const h of holds) h.release();
      const settled = await Promise.race([
        Promise.all([aliceP, bobP]).then(() => true),
        new Promise<false>((r) => setTimeout(() => r(false), 20))
      ]);
      if (settled) break;
    }

    await Promise.all([aliceP, bobP]);
    registry.release("alice");
    registry.release("bob");

    // Second open of bob only after close-end:bob
    const closeEndIdx = events.indexOf("close-end:bob");
    const opensBob = events
      .map((e, i) => (e === "open:bob" ? i : -1))
      .filter((i) => i >= 0);
    expect(opensBob.length).toBe(2);
    expect(closeEndIdx).toBeGreaterThanOrEqual(0);
    expect(opensBob[1]).toBeGreaterThan(closeEndIdx);
    expect(openWhileCloseActive).toBe(0);

    await registry.closeAll();
  });
});

describe("KD16 production memory factory rejected", () => {
  it("assertDurableUserScopedOrThrow rejects production + scoped + non-durable", () => {
    expect(() =>
      assertDurableUserScopedOrThrow(
        {
          DEPLOYMENT_PROFILE: "production",
          PRODUCT_USER_SCOPED_STATE: "1"
        },
        { durable: false, productStoreMode: "memory" }
      )
    ).toThrow(/durable Surreal/);
  });

  it("assert allows non-production memory scoped", () => {
    expect(() =>
      assertDurableUserScopedOrThrow(
        { PRODUCT_USER_SCOPED_STATE: "1" },
        { durable: false, productStoreMode: "memory" }
      )
    ).not.toThrow();
  });

  it("assert allows production when durable surreal registry is present", () => {
    expect(() =>
      assertDurableUserScopedOrThrow(
        {
          DEPLOYMENT_PROFILE: "production",
          PRODUCT_USER_SCOPED_STATE: "1"
        },
        { durable: true, productStoreMode: "surreal" }
      )
    ).not.toThrow();
  });
});

describe("flag=0 path unchanged smoke", () => {
  it("isUserScopedStateEnabled defaults off", () => {
    expect(isUserScopedStateEnabled({})).toBe(false);
    expect(isUserScopedStateEnabled({ PRODUCT_USER_SCOPED_STATE: "0" })).toBe(false);
    expect(isUserScopedStateEnabled({ PRODUCT_USER_SCOPED_STATE: "1" })).toBe(true);
  });
});

describe("scoped adapter capability forward", () => {
  it("forwards getPersistHealth / flush / governance generation", async () => {
    const factory = createInMemoryUserRepoFactory();
    const inner = factory.getOrCreate("alice") as ReturnType<typeof createInMemoryProductStateRepository> & {
      getPersistHealth?: () => { consecutiveFailures: number };
      flush?: () => Promise<void>;
    };
    let flushed = false;
    inner.getPersistHealth = () => ({ consecutiveFailures: 2 });
    inner.flush = async () => {
      flushed = true;
    };

    const scoped = createUserScopedProductStateRepository({
      getOrCreate: (u) => factory.getOrCreate(u),
      fallbackUsername: "alice"
    });

    await runWithPrincipal({ kind: "user", username: "alice" }, async () => {
      expect(scoped.getPersistHealth?.()?.consecutiveFailures).toBe(2);
      expect(scoped.getGovernanceGeneration?.()).toBe(0);
      await scoped.flush?.();
      expect(flushed).toBe(true);
    });
  });
});
