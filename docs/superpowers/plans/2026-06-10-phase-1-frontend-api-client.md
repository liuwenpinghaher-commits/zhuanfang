# Phase 1 Frontend API Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a frontend Product API client and wire it into app bootstrap/reset while preserving localStorage fallback when the backend is unavailable.

**Architecture:** The client lives in `src/api/productApi.ts` and normalizes every returned ProductState through the existing storage normalizer. `App.tsx` keeps localStorage as the initial synchronous state, then attempts a remote state load after mount; reset attempts the API first and falls back locally on network failure.

**Tech Stack:** React 18, TypeScript, Fetch API, Vitest, existing ProductState domain types.

---

## File Structure

- Create: `src/api/productApi.ts` - typed API client for health/state/reset.
- Create: `src/api/productApi.test.ts` - fake fetch tests for success and failure behavior.
- Modify: `src/App.tsx` - load remote state after mount and use API reset when available.
- Modify: `src/ui.ts` only if a user-facing notice helper is needed.

## Task 1: Product API Client

**Files:**
- Create: `src/api/productApi.test.ts`
- Create: `src/api/productApi.ts`

- [ ] **Step 1: Write failing client tests**

Create `src/api/productApi.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { createInitialProductState } from "../domain/engine";
import { createProductApiClient } from "./productApi";

describe("product api client", () => {
  it("loads and normalizes product state from the API", async () => {
    const state = createInitialProductState();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(state), { status: 200 }));
    const client = createProductApiClient("http://127.0.0.1:8787", fetchImpl);

    const result = await client.getState();

    expect(fetchImpl).toHaveBeenCalledWith("http://127.0.0.1:8787/api/state", { method: "GET" });
    expect(result.profile.name).toBe("Mia");
    expect(result.systemConfig.search.activeProvider).toBe("anysearch");
  });

  it("resets state through the API", async () => {
    const state = createInitialProductState();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(state), { status: 200 }));
    const client = createProductApiClient("http://127.0.0.1:8787", fetchImpl);

    const result = await client.resetState();

    expect(fetchImpl).toHaveBeenCalledWith("http://127.0.0.1:8787/api/state/reset", { method: "POST" });
    expect(result.profile.name).toBe("Mia");
  });

  it("reports unavailable API health without throwing", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const client = createProductApiClient("http://127.0.0.1:8787", fetchImpl);

    await expect(client.health()).resolves.toBe(false);
  });
});
```

- [ ] **Step 2: Run client tests and verify failure**

Run: `npm test -- --run src/api/productApi.test.ts`

Expected: FAIL because `src/api/productApi.ts` does not exist.

- [ ] **Step 3: Implement client**

Implement `src/api/productApi.ts` with:

```ts
import { normalizeProductState } from "../domain/storage";
import type { ProductState } from "../domain/types";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ProductApiClient {
  health(): Promise<boolean>;
  getState(): Promise<ProductState>;
  resetState(): Promise<ProductState>;
}

export function getProductApiBaseUrl() {
  return import.meta.env.VITE_PRODUCT_API_BASE_URL ?? "http://127.0.0.1:8787";
}

export function createProductApiClient(baseUrl = getProductApiBaseUrl(), fetchImpl: FetchLike = fetch): ProductApiClient {
  const normalizedBaseUrl = baseUrl.replace(/\/$/, "");

  async function requestJson(path: string, init: RequestInit): Promise<unknown> {
    const response = await fetchImpl(`${normalizedBaseUrl}${path}`, init);
    if (!response.ok) {
      throw new Error(`Product API request failed: ${response.status}`);
    }
    return response.json();
  }

  return {
    async health() {
      try {
        const response = await fetchImpl(`${normalizedBaseUrl}/api/health`, { method: "GET" });
        return response.ok;
      } catch {
        return false;
      }
    },
    async getState() {
      return normalizeProductState(await requestJson("/api/state", { method: "GET" }));
    },
    async resetState() {
      return normalizeProductState(await requestJson("/api/state/reset", { method: "POST" }));
    }
  };
}

export const productApiClient = createProductApiClient();
```

- [ ] **Step 4: Run client tests**

Run: `npm test -- --run src/api/productApi.test.ts`

Expected: PASS.

## Task 2: App Bootstrap and Reset Fallback

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Add failing behavior expectation by running existing E2E with backend absent**

Run: `npm run test:e2e -- navigation.spec.ts`

Expected before app changes: PASS; this establishes that backend-absent behavior must remain stable.

- [ ] **Step 2: Wire remote state load after mount**

Modify `src/App.tsx` to import `productApiClient`, then add an effect after local state setup:

```ts
useEffect(() => {
  let cancelled = false;
  productApiClient
    .getState()
    .then((remoteState) => {
      if (!cancelled) {
        setProductState(remoteState);
      }
    })
    .catch(() => {
      // Local demo fallback remains authoritative when API is offline.
    });
  return () => {
    cancelled = true;
  };
}, []);
```

- [ ] **Step 3: Wire reset fallback**

Change `resetData` to `async function resetData()` and try `productApiClient.resetState()` before falling back to `resetProductState()`.

- [ ] **Step 4: Run E2E navigation with API absent**

Run: `npm run test:e2e -- navigation.spec.ts`

Expected: PASS, proving local fallback remains stable.

## Task 3: Full Verification

**Files:**
- All files touched in this plan.

- [ ] **Step 1: Run unit tests**

Run: `npm test -- --run`

Expected: all Vitest tests pass.

- [ ] **Step 2: Run production build**

Run: `npm run build`

Expected: TypeScript and Vite build pass.

- [ ] **Step 3: Run all E2E tests**

Run: `npm run test:e2e`

Expected: all Playwright tests pass.

- [ ] **Step 4: Record no-git status**

Run: `test -d .git && git status --short || echo "no git repository; skipping commit"`

Expected: prints `no git repository; skipping commit`.
