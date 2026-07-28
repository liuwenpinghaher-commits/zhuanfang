import { describe, expect, it } from "vitest";
import {
  applyImportanceDecay,
  decayImportance,
  detectMemoryContradictions,
  buildContradictionCandidates
} from "./memory-consolidation";
import type { MemoryRecord } from "./types";

function rec(partial: Partial<MemoryRecord> & Pick<MemoryRecord, "id" | "text">): MemoryRecord {
  return {
    status: "confirmed",
    sourceType: "interview_session",
    sourceId: "s1",
    evidenceQuote: "",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    importance: 8,
    ...partial
  };
}

describe("decayImportance", () => {
  it("halves roughly after one half-life", () => {
    const now = "2026-04-01T00:00:00.000Z";
    const touch = "2026-01-01T00:00:00.000Z"; // ~90 days
    const next = decayImportance(8, touch, now, 90);
    expect(next).toBeLessThan(8);
    expect(next).toBeGreaterThanOrEqual(1);
  });
});

describe("applyImportanceDecay", () => {
  it("decays stale confirmed memories only", () => {
    const records = [
      rec({ id: "a", text: "我总是亲自拍板", lastAccessedAt: "2025-01-01T00:00:00.000Z", importance: 10 }),
      rec({ id: "b", text: "新记忆", lastAccessedAt: "2026-07-28T00:00:00.000Z", importance: 6 })
    ];
    const out = applyImportanceDecay(records, "2026-07-28T00:00:00.000Z", 90);
    expect((out[0]!.importance ?? 10)).toBeLessThan(10);
    expect(out[1]!.importance).toBe(6);
  });
});

describe("detectMemoryContradictions", () => {
  it("flags opposing polarity with shared topic", () => {
    const pairs = detectMemoryContradictions([
      rec({ id: "1", text: "团队授权时我应该亲自拍板每一个细节" }),
      rec({ id: "2", text: "团队授权时我不应该亲自拍板每一个细节" })
    ]);
    expect(pairs.length).toBeGreaterThan(0);
    const cands = buildContradictionCandidates(pairs);
    expect(cands[0]!.text).toContain("【待裁决矛盾】");
    expect(cands[0]!.suggestedUpdate).toBe("conflict");
  });
});
