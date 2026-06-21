import { describe, it, expect } from "vitest";
import { buildKnowledgeChunks } from "./knowledge";
import { createInitialProductState } from "./engine";
import type { InterviewTurn } from "./types";

describe("buildKnowledgeChunks", () => {
  it("把蒸馏资产各切成块,带 sourceType/sourceId,离线无嵌入", () => {
    const state = createInitialProductState(); // seed 含 themes/points/memory 等
    const chunks = buildKnowledgeChunks(state, new Map());
    const types = new Set(chunks.map((c) => c.sourceType));
    expect(chunks.length).toBeGreaterThan(0);
    expect([...types].some((t) => ["memory", "theme", "point", "note"].includes(t))).toBe(true);
    expect(chunks.every((c) => c.id && c.sourceId && c.text)).toBe(true);
    expect(chunks.every((c) => c.embedding === undefined)).toBe(true);
  });
  it("transcript 按 user 轮切块(来自冷层 map)", () => {
    const state = createInitialProductState();
    const sid = state.sessions[0]?.id ?? "s1";
    const turns: InterviewTurn[] = [
      { id: "t1", role: "user", content: "我担心放权失控。", intent: "", timestamp: "2026-06-22T00:00:00.000Z" },
      { id: "t2", role: "assistant", content: "为什么?", intent: "", timestamp: "2026-06-22T00:00:00.000Z" }
    ];
    const withSession = { ...state, sessions: state.sessions.length ? state.sessions : [{ id: sid } as any] };
    const chunks = buildKnowledgeChunks(withSession, new Map([[withSession.sessions[0].id, turns]]));
    const t = chunks.filter((c) => c.sourceType === "transcript");
    expect(t.length).toBe(1); // 只 user 轮
    expect(t[0].sourceId).toContain(withSession.sessions[0].id);
    expect(t[0].text).toContain("放权");
  });
});
