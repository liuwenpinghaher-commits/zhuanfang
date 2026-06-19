import { describe, it, expect } from "vitest";

import { dedupeMemoryRecords, planMemoryUpdate } from "./memory";
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

  it("fires the offline hint for near-identical finalize candidates from different sessions (prefix stripped)", () => {
    // Same insight resurfaces in two sessions: identical salient content, different 《title》.
    // Stripping the shared "用户在《title》中表达：" boilerplate plus the lower no-embedding token
    // threshold makes the dedup hint fire offline — it stayed silent before (boilerplate diluted overlap,
    // default 0.88 was unreachable for token-Jaccard). Token overlap only catches near-literal repeats;
    // true paraphrase dedup still needs embeddings.
    const existing: MemoryRecord[] = [
      confirmedRecord({ id: "m1", text: "用户在《放权的纠结》中表达：先小范围验证再放权，避免一次性把审批权全部交出去" })
    ];
    const plan = planMemoryUpdate(
      { text: "用户在《今天的复盘》中表达：先小范围验证再放权，避免一次性把审批权全部交出去" },
      existing
    );
    expect(plan.op).toBe("update");
    expect(plan.similarToRecordId).toBe("m1");
  });

  it("does not falsely match two finalize candidates that share only the template prefix", () => {
    const existing: MemoryRecord[] = [
      confirmedRecord({ id: "m1", text: "用户在《放权》中表达：喜欢在清晨独自散步思考" })
    ];
    const plan = planMemoryUpdate(
      { text: "用户在《产品复盘》中表达：讨厌冗长的跨部门对齐会议" },
      existing
    );
    expect(plan.op).toBe("add"); // shared prefix alone must not trigger a merge hint
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

describe("dedupeMemoryRecords (lightweight consolidation, M5)", () => {
  it("merges near-identical confirmed memories, keeping the stronger", () => {
    const recs = [
      { id: "a", text: "先验证再放权", status: "confirmed", importance: 8, createdAt: "2026-06-19T00:00:00Z", embedding: [0.1, 0.2] },
      { id: "b", text: "先验证再授权", status: "confirmed", importance: 3, createdAt: "2026-05-01T00:00:00Z", embedding: [0.1, 0.21] }
    ] as any;
    const out = dedupeMemoryRecords(recs, { threshold: 0.9 });
    expect(out.find((r: MemoryRecord) => r.id === "b")?.status).toBe("deprecated"); // 弱者(importance 低/更旧)被弃
    expect(out.find((r: MemoryRecord) => r.id === "a")?.status).toBe("confirmed"); // 强者留
  });

  it("keeps unrelated memories untouched", () => {
    const recs = [
      { id: "a", text: "喜欢喝咖啡", status: "confirmed" },
      { id: "b", text: "讨厌开会", status: "confirmed" }
    ] as any;
    const out = dedupeMemoryRecords(recs, { threshold: 0.9 });
    expect(out.every((r: MemoryRecord) => r.status === "confirmed")).toBe(true);
  });

  it("does not mutate the input array (immutable)", () => {
    const recs = [
      confirmedRecord({ id: "a", text: "先验证再放权", importance: 8, embedding: [0.1, 0.2] }),
      confirmedRecord({ id: "b", text: "先验证再授权", importance: 3, embedding: [0.1, 0.21] })
    ];
    const out = dedupeMemoryRecords(recs, { threshold: 0.9 });
    expect(out).not.toBe(recs);
    expect(recs.every((r) => r.status === "confirmed")).toBe(true); // 原数组不被改
    expect(out.find((r) => r.id === "b")?.status).toBe("deprecated");
  });

  it("records a consolidation reason that points at the kept record", () => {
    const recs = [
      confirmedRecord({ id: "keep", text: "先验证再放权", importance: 8, embedding: [0.1, 0.2] }),
      confirmedRecord({ id: "weak", text: "先验证再授权", importance: 3, embedding: [0.1, 0.21] })
    ];
    const out = dedupeMemoryRecords(recs, { threshold: 0.9 });
    const weak = out.find((r) => r.id === "weak");
    expect(weak?.status).toBe("deprecated");
    expect(weak?.deprecatedReason).toContain("记忆整理");
    expect(weak?.deprecatedReason).toContain("keep"); // 指向保留者 id
  });

  it("on importance tie, deprecates the older record", () => {
    const recs = [
      confirmedRecord({ id: "newer", text: "先验证再放权", importance: 5, createdAt: "2026-06-19T00:00:00Z", embedding: [0.1, 0.2] }),
      confirmedRecord({ id: "older", text: "先验证再授权", importance: 5, createdAt: "2026-05-01T00:00:00Z", embedding: [0.1, 0.21] })
    ];
    const out = dedupeMemoryRecords(recs, { threshold: 0.9 });
    expect(out.find((r) => r.id === "older")?.status).toBe("deprecated");
    expect(out.find((r) => r.id === "newer")?.status).toBe("confirmed");
  });

  it("merges near-duplicates via token overlap when embeddings are absent", () => {
    const recs = [
      confirmedRecord({ id: "keep", text: "用户偏好先小范围验证再放权后扩大试点", importance: 7 }),
      confirmedRecord({ id: "weak", text: "用户偏好先小范围验证再放权后扩大", importance: 2 })
    ];
    const out = dedupeMemoryRecords(recs, { threshold: 0.5 });
    expect(out.find((r) => r.id === "weak")?.status).toBe("deprecated");
    expect(out.find((r) => r.id === "keep")?.status).toBe("confirmed");
  });

  it("ignores non-confirmed records (only confirmed are consolidated)", () => {
    const recs = [
      confirmedRecord({ id: "a", text: "先验证再放权", importance: 8, embedding: [0.1, 0.2] }),
      confirmedRecord({ id: "b", text: "先验证再授权", importance: 3, status: "deprecated", embedding: [0.1, 0.21] })
    ];
    const out = dedupeMemoryRecords(recs, { threshold: 0.9 });
    // b is already deprecated → untouched, a stays confirmed (nothing to merge against)
    expect(out.find((r) => r.id === "a")?.status).toBe("confirmed");
    expect(out.find((r) => r.id === "b")?.status).toBe("deprecated");
  });
});
