import { describe, it, expect } from "vitest";
import { collectEdges, turnRecordsOf } from "./edge-mapper";
import { createInitialProductState } from "../../../../src/domain/engine";

function baseState() {
  const s = createInitialProductState();
  return {
    ...s,
    themes: [{ id: "th_1", name: "放权", summary: "", maturity: "聚焦" as const, representativeQuote: "", appearances: 1, nextQuestion: "", updatedAt: "2026-06-27T00:00:00.000Z" }],
    sessions: [{ ...s.sessions[0], id: "se_1", turns: [
      { id: "tu_1", role: "user" as const, content: "原话", intent: "", timestamp: "2026-06-27T00:00:00.000Z" }
    ] }],
    points: [{ id: "pt_1", title: "t", content: "c", status: "稳定观点" as const, confidence: "用户确认" as const, evidence: [], relatedThemeIds: ["th_1"], important: false, updatedAt: "2026-06-27T00:00:00.000Z", evidenceAnchors: [{ sessionId: "se_1", turnId: "tu_1" }] }],
    decisions: [{ id: "de_1", title: "t", decisionKind: "用户决策" as const, confirmationStatus: "用户确认" as const, choice: "c", tradeOff: "", riskHypothesis: "", reviewAt: "", status: "待复盘" as const, updatedAt: "2026-06-27T00:00:00.000Z", relatedThemeIds: ["th_1"] }],
    memoryRecords: [{ id: "me_1", text: "x", status: "confirmed" as const, sourceType: "profile" as const, sourceId: "p", evidenceQuote: "", createdAt: "2026-06-27T00:00:00.000Z", updatedAt: "2026-06-27T00:00:00.000Z" }],
    memoryEdges: [{ fromMemoryRecordId: "me_1", themeId: "th_1" }]
  };
}

describe("edge-mapper", () => {
  it("relatedThemeIds → belongs_to_theme(point + decision 都覆盖,根治召回漏类)", () => {
    const edges = collectEdges(baseState());
    const bt = edges.filter((e) => e.edge === "belongs_to_theme");
    expect(bt).toContainEqual(expect.objectContaining({ edge: "belongs_to_theme", fromTable: "point", fromId: "pt_1", toTable: "theme", toId: "th_1" }));
    expect(bt).toContainEqual(expect.objectContaining({ fromTable: "decision", fromId: "de_1", toTable: "theme", toId: "th_1" }));
  });

  it("evidenceAnchors → derived_from(带 provenance,指向现存 turn)", () => {
    const df = collectEdges(baseState()).filter((e) => e.edge === "derived_from");
    expect(df).toContainEqual(expect.objectContaining({
      edge: "derived_from", fromTable: "point", fromId: "pt_1", toTable: "turn", toId: "tu_1",
      data: { provenance: { origin: "llm_extracted", sessionId: "se_1", turnId: "tu_1" } }
    }));
  });

  it("memoryEdges → about_theme", () => {
    const at = collectEdges(baseState()).filter((e) => e.edge === "about_theme");
    expect(at).toContainEqual(expect.objectContaining({ edge: "about_theme", fromTable: "memory", fromId: "me_1", toTable: "theme", toId: "th_1" }));
  });

  it("session.turns → part_of + turn 记录", () => {
    const st = baseState();
    expect(collectEdges(st)).toContainEqual(expect.objectContaining({ edge: "part_of", fromTable: "turn", fromId: "tu_1", toTable: "session", toId: "se_1" }));
    const turns = turnRecordsOf(st);
    expect(turns).toContainEqual(expect.objectContaining({ id: "tu_1", sessionId: "se_1", role: "user", content: "原话" }));
  });

  it("过滤悬挂边:指向不存在 turn/theme 的锚点/关联不产边", () => {
    const st = baseState();
    st.points[0].evidenceAnchors = [{ sessionId: "se_x", turnId: "tu_missing" }];
    st.decisions[0].relatedThemeIds = ["th_missing"];
    const edges = collectEdges(st);
    expect(edges.some((e) => e.edge === "derived_from" && e.toId === "tu_missing")).toBe(false);
    expect(edges.some((e) => e.edge === "belongs_to_theme" && e.toId === "th_missing")).toBe(false);
  });
});
