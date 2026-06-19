import { describe, it, expect } from "vitest";

import { planMemoryUpdate } from "./memory";
import type { MemoryRecord } from "./types";

function confirmedRecord(partial: Partial<MemoryRecord> & { id: string; text: string }): MemoryRecord {
  return {
    status: "confirmed",
    sourceType: "interview_session",
    sourceId: "s1",
    evidenceQuote: "",
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z",
    ...partial
  } as MemoryRecord;
}

describe("planMemoryUpdate (extract-then-update dedup hint, HITL surfaced)", () => {
  it("flags near-duplicate candidate vs existing memories (embedding cosine)", () => {
    const existing: MemoryRecord[] = [
      confirmedRecord({ id: "m1", text: "用户偏好先小范围验证再放权", embedding: [0.1, 0.2, 0.3] })
    ];
    const plan = planMemoryUpdate(
      { text: "用户喜欢先验证再授权", embedding: [0.1, 0.2, 0.31] },
      existing,
      { threshold: 0.9 }
    );
    expect(plan.op).toBe("update");
    expect(plan.similarToRecordId).toBe("m1");
  });

  it("returns add when nothing similar (token fallback without embedding)", () => {
    const existing: MemoryRecord[] = [
      confirmedRecord({ id: "m1", text: "用户偏好先验证再放权" })
    ];
    const plan = planMemoryUpdate(
      { text: "完全无关的内容 xyz123" },
      existing,
      { threshold: 0.9 }
    );
    expect(plan.op).toBe("add");
    expect(plan.similarToRecordId).toBeUndefined();
  });

  it("flags near-duplicate via token overlap when embeddings are absent", () => {
    const existing: MemoryRecord[] = [
      confirmedRecord({ id: "m1", text: "用户偏好先小范围验证再放权后扩大" })
    ];
    const plan = planMemoryUpdate(
      { text: "用户偏好先小范围验证再放权后扩大试点" },
      existing,
      { threshold: 0.5 }
    );
    expect(plan.op).toBe("update");
    expect(plan.similarToRecordId).toBe("m1");
  });

  it("ignores non-confirmed records when planning", () => {
    const existing: MemoryRecord[] = [
      confirmedRecord({ id: "m1", text: "用户偏好先小范围验证再放权", status: "deprecated", embedding: [0.1, 0.2, 0.3] })
    ];
    const plan = planMemoryUpdate(
      { text: "用户偏好先小范围验证再放权", embedding: [0.1, 0.2, 0.3] },
      existing,
      { threshold: 0.9 }
    );
    expect(plan.op).toBe("add");
  });

  it("defaults to add against an empty memory store", () => {
    const plan = planMemoryUpdate({ text: "用户偏好先验证再放权" }, []);
    expect(plan.op).toBe("add");
  });

  it("picks the single most similar record as the merge target", () => {
    const existing: MemoryRecord[] = [
      confirmedRecord({ id: "m-low", text: "用户喜欢周五开会复盘", embedding: [1, 0, 0] }),
      confirmedRecord({ id: "m-high", text: "用户偏好先验证再放权", embedding: [0.1, 0.2, 0.3] })
    ];
    const plan = planMemoryUpdate(
      { text: "用户喜欢先验证再授权", embedding: [0.1, 0.2, 0.31] },
      existing,
      { threshold: 0.9 }
    );
    expect(plan.op).toBe("update");
    expect(plan.similarToRecordId).toBe("m-high");
  });
});
