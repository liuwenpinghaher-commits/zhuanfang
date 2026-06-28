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
    // M1: 记忆主题归属内嵌于 record.relatedThemeIds(退役 state.memoryEdges)。
    memoryRecords: [{ id: "me_1", text: "x", status: "confirmed" as const, sourceType: "profile" as const, sourceId: "p", evidenceQuote: "", createdAt: "2026-06-27T00:00:00.000Z", updatedAt: "2026-06-27T00:00:00.000Z", relatedThemeIds: ["th_1"] }]
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

  it("record.relatedThemeIds → about_theme(M1:统一内嵌软链投影)", () => {
    const at = collectEdges(baseState()).filter((e) => e.edge === "about_theme");
    expect(at).toContainEqual(expect.objectContaining({ edge: "about_theme", fromTable: "memory", fromId: "me_1", toTable: "theme", toId: "th_1" }));
  });

  it("M1:about_theme 过滤 theme 端 —— record 指向不存在主题时不产悬挂边;from 端遍历真实 record(隐式不悬挂)", () => {
    const st = baseState();
    // 给 me_1 追加一个指向不存在主题的归属,且新增一条挂同主题 th_1 的真实记忆 me_2。
    const withGhostTheme = {
      ...st,
      memoryRecords: [
        { ...st.memoryRecords[0], relatedThemeIds: ["th_1", "th_gone"] },
        { id: "me_2", text: "y", status: "confirmed" as const, sourceType: "profile" as const, sourceId: "p", evidenceQuote: "", createdAt: "2026-06-27T00:00:00.000Z", updatedAt: "2026-06-27T00:00:00.000Z", relatedThemeIds: ["th_1"] }
      ]
    };
    const at = collectEdges(withGhostTheme).filter((e) => e.edge === "about_theme");
    expect(at.map((e) => e.fromId).sort()).toEqual(["me_1", "me_2"]);     // 两条真实记忆各产边
    expect(at.map((e) => e.toId)).not.toContain("th_gone");                // 指向不存在主题的归属被过滤,不悬挂
    expect(at.every((e) => e.toId === "th_1")).toBe(true);
  });

  it("session.turns → part_of + turn 记录", () => {
    const st = baseState();
    expect(collectEdges(st)).toContainEqual(expect.objectContaining({ edge: "part_of", fromTable: "turn", fromId: "tu_1", toTable: "session", toId: "se_1" }));
    const turns = turnRecordsOf(st);
    expect(turns).toContainEqual(expect.objectContaining({ id: "tu_1", sessionId: "se_1", role: "user", content: "原话" }));
  });

  it("过滤悬挂边:theme/memory 端按 known-id 过滤;derived_from 改从资产 anchor 投影(H1)", () => {
    const st = baseState();
    // H1:derived_from 不再按内存 turnIds 过滤(turn 是 append-only 冷层,降冷后内存 turns 空
    //     但 turn 节点仍在 surreal)。资产持锚点即投影边,溯源召回不被降冷打断。
    st.points[0].evidenceAnchors = [{ sessionId: "se_x", turnId: "tu_missing" }];
    st.decisions[0].relatedThemeIds = ["th_missing"];
    const edges = collectEdges(st);
    expect(edges.some((e) => e.edge === "derived_from" && e.toId === "tu_missing")).toBe(true);
    // belongs_to_theme/about_theme 的 theme 端过滤仍在(theme 不是 append-only,悬挂会污染聚合)。
    expect(edges.some((e) => e.edge === "belongs_to_theme" && e.toId === "th_missing")).toBe(false);
  });

  it("H1:降冷剥 turns 后,持锚点资产仍投影 derived_from(溯源边不丢)", () => {
    const st = baseState();
    // 模拟 offloadCompletedSession:session.turns 被剥空,但 point 仍保留 evidenceAnchors。
    st.sessions[0].turns = [];
    const edges = collectEdges(st);
    expect(edges).toContainEqual(expect.objectContaining({
      edge: "derived_from", fromTable: "point", fromId: "pt_1", toTable: "turn", toId: "tu_1"
    }));
    // turns 空 → 不再产 part_of(persist 侧靠"part_of 跳 DELETE"保住已写的边)。
    expect(edges.some((e) => e.edge === "part_of")).toBe(false);
  });
});
