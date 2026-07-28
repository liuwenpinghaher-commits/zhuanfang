/**
 * Structural + behavioral regression for durable product-state writes.
 * Criterion 1 (2026-07-23): success paths that mutate durable state must await
 * confirmPersisted (via replaceStateDurable) or fail closed — not silent 200+async.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createInMemoryProductStateRepository,
  replaceStateDurable
} from "../product-state-repository";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Production write surfaces that previously used naked replaceState. */
const MUST_USE_DURABLE = [
  "routes/import.ts",
  "routes/corpus.ts",
  "routes/raw-material.ts",
  "routes/realtime-voice.ts",
  "routes/interview-sessions.ts",
  "routes/chat.ts",
  "routes/search.ts",
  "routes/podcast.ts",
  "routes/memory-candidates.ts",
  "research-scheduler.ts",
  "routes/knowledge.ts"
] as const;

function load(rel: string): string {
  return readFileSync(join(root, rel), "utf8");
}

describe("durable write surfaces (structural)", () => {
  for (const rel of MUST_USE_DURABLE) {
    it(`${rel} uses replaceStateDurable on production success paths`, () => {
      const src = load(rel);
      expect(src, `${rel} must import replaceStateDurable`).toMatch(/replaceStateDurable/);
      // Disallow naked product/stateRepo.replaceState( on success paths, allowing:
      // - replaceStateDurable(repo, ...) which contains the call inside the helper
      // - comments
      // - test files (not in this list)
      const naked =
        /(?:repository|productRepo|stateRepo|options\.repository)\.replaceState\s*\(/.exec(src);
      expect(naked, `${rel} still has naked *.replaceState(`).toBeNull();
    });
  }
});

describe("replaceStateDurable (shipped helper)", () => {
  it("awaits confirmPersisted when present before resolving", async () => {
    const inner = createInMemoryProductStateRepository();
    let confirmed = false;
    const repo = {
      ...inner,
      replaceState: (s: Parameters<typeof inner.replaceState>[0], o?: Parameters<typeof inner.replaceState>[1]) =>
        inner.replaceState(s, o),
      confirmPersisted: async () => {
        confirmed = true;
      }
    };
    const before = repo.getState();
    const next = await replaceStateDurable(repo, before);
    expect(confirmed).toBe(true);
    expect(next.revision).toBe((before.revision ?? 0) + 1);
  });

  it("propagates confirmPersisted failure so callers cannot claim silent success", async () => {
    const inner = createInMemoryProductStateRepository();
    const repo = {
      ...inner,
      replaceState: (s: Parameters<typeof inner.replaceState>[0], o?: Parameters<typeof inner.replaceState>[1]) =>
        inner.replaceState(s, o),
      confirmPersisted: async () => {
        throw new Error("persist failed under test");
      }
    };
    await expect(replaceStateDurable(repo, repo.getState())).rejects.toThrow(/persist failed under test/);
  });
});
