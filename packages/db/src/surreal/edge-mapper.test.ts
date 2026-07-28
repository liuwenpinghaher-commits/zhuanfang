import { describe, it, expect } from "vitest";
import { collectEdges, turnRecordsOf, turnRecordsFromRawMaterials } from "./edge-mapper";
import { createInitialProductState } from "../../../../src/domain/engine";
import type { ProductState } from "../../../../src/domain/types";

function baseState(): ProductState {
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
    // ⑤:pt_1 confidence='用户确认' → origin='user_confirmed'(不再写死 llm_extracted)
    expect(df).toContainEqual(expect.objectContaining({
      edge: "derived_from", fromTable: "point", fromId: "pt_1", toTable: "turn", toId: "tu_1",
      data: { provenance: { origin: "user_confirmed", sessionId: "se_1", turnId: "tu_1" } }
    }));
  });

  it("⑤ provenance.origin 按确认状态真区分(user_confirmed vs llm_extracted)", () => {
    const s = baseState();
    const state: ProductState = {
      ...s,
      points: [
        ...s.points, // pt_1: confidence='用户确认' → user_confirmed
        { id: "pt_2", title: "t2", content: "c2", status: "临时想法" as const, confidence: "AI 推断" as const, evidence: [], relatedThemeIds: ["th_1"], important: false, updatedAt: "2026-06-27T00:00:00.000Z", evidenceAnchors: [{ sessionId: "se_1", turnId: "tu_1" }] }
      ]
    };
    const df = collectEdges(state).filter((e) => e.edge === "derived_from");
    expect(df.find((e) => e.fromId === "pt_1")?.data?.provenance.origin).toBe("user_confirmed");
    expect(df.find((e) => e.fromId === "pt_2")?.data?.provenance.origin).toBe("llm_extracted");
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

  // ⑤ 轻量推理(欠账②):contradictsPointIds → contradicts 边(point↔point,symmetric)。
  it("contradictsPointIds → contradicts(symmetric 去重:A↔B 只投影一条,按 id 字典序 from<to)", () => {
    const st = baseState();
    // 两条互指对立的观点 + 第三条无关。双向软链应只产一条 contradicts(pt_a < pt_b)。
    st.points = [
      { id: "pt_b", title: "t", content: "c", status: "被挑战中", confidence: "AI 推断", evidence: [], relatedThemeIds: ["th_1"], important: false, updatedAt: "2026-06-27T00:00:00.000Z", contradictsPointIds: ["pt_a"] },
      { id: "pt_a", title: "t", content: "c", status: "稳定观点", confidence: "用户确认", evidence: [], relatedThemeIds: ["th_1"], important: false, updatedAt: "2026-06-27T00:00:00.000Z", contradictsPointIds: ["pt_b"] }
    ];
    const cd = collectEdges(st).filter((e) => e.edge === "contradicts");
    expect(cd).toHaveLength(1);
    expect(cd[0]).toEqual(expect.objectContaining({ edge: "contradicts", fromTable: "point", fromId: "pt_a", toTable: "point", toId: "pt_b" }));
  });

  it("contradicts:单向软链也产边(只一端记录对立时不漏)", () => {
    const st = baseState();
    st.points = [
      { id: "pt_a", title: "t", content: "c", status: "稳定观点" as const, confidence: "用户确认" as const, evidence: [], relatedThemeIds: ["th_1"], important: false, updatedAt: "2026-06-27T00:00:00.000Z", contradictsPointIds: ["pt_b"] },
      { id: "pt_b", title: "t", content: "c", status: "稳定观点" as const, confidence: "用户确认" as const, evidence: [], relatedThemeIds: ["th_1"], important: false, updatedAt: "2026-06-27T00:00:00.000Z" }
    ];
    const cd = collectEdges(st).filter((e) => e.edge === "contradicts");
    expect(cd).toHaveLength(1);
    expect(cd[0]).toEqual(expect.objectContaining({ fromId: "pt_a", toId: "pt_b" }));
  });

  it("contradicts:point 端 known-id 过滤(指向不存在 point 不产悬挂边)", () => {
    const st = baseState();
    st.points = [
      { id: "pt_a", title: "t", content: "c", status: "稳定观点" as const, confidence: "用户确认" as const, evidence: [], relatedThemeIds: ["th_1"], important: false, updatedAt: "2026-06-27T00:00:00.000Z", contradictsPointIds: ["pt_gone"] }
    ];
    const cd = collectEdges(st).filter((e) => e.edge === "contradicts");
    expect(cd).toHaveLength(0);
  });

  it("contradicts:自指被忽略(A→A 不产边)", () => {
    const st = baseState();
    st.points = [
      { id: "pt_a", title: "t", content: "c", status: "稳定观点" as const, confidence: "用户确认" as const, evidence: [], relatedThemeIds: ["th_1"], important: false, updatedAt: "2026-06-27T00:00:00.000Z", contradictsPointIds: ["pt_a"] }
    ];
    const cd = collectEdges(st).filter((e) => e.edge === "contradicts");
    expect(cd).toHaveLength(0);
  });

  // ⑥ 取代关系(欠账②):supersededByPointId → evolves_into(复活死 schema + 图层可达)。
  it("supersededByPointId → evolves_into(旧→新有向,复活死 schema)", () => {
    const st = baseState();
    st.points = [
      { id: "pt_old", title: "t", content: "c", status: "已修正" as const, confidence: "AI 推断" as const, evidence: [], relatedThemeIds: ["th_1"], important: false, updatedAt: "2026-06-27T00:00:00.000Z", supersededByPointId: "pt_new" },
      { id: "pt_new", title: "t", content: "c", status: "稳定观点" as const, confidence: "用户确认" as const, evidence: [], relatedThemeIds: ["th_1"], important: false, updatedAt: "2026-06-27T00:00:00.000Z" }
    ];
    const ev = collectEdges(st).filter((e) => e.edge === "evolves_into");
    expect(ev).toHaveLength(1);
    expect(ev[0]).toEqual(expect.objectContaining({ edge: "evolves_into", fromTable: "point", fromId: "pt_old", toTable: "point", toId: "pt_new" }));
  });

  it("evolves_into:取代方不存在(悬挂)/自指 不产边", () => {
    const st = baseState();
    st.points = [
      { id: "pt_old", title: "t", content: "c", status: "已修正" as const, confidence: "AI 推断" as const, evidence: [], relatedThemeIds: ["th_1"], important: false, updatedAt: "2026-06-27T00:00:00.000Z", supersededByPointId: "pt_gone" },
      { id: "pt_self", title: "t", content: "c", status: "临时想法" as const, confidence: "AI 推断" as const, evidence: [], relatedThemeIds: ["th_1"], important: false, updatedAt: "2026-06-27T00:00:00.000Z", supersededByPointId: "pt_self" }
    ];
    expect(collectEdges(st).filter((e) => e.edge === "evolves_into")).toHaveLength(0);
  });
});

describe("turnRecordsFromRawMaterials (P0 import)", () => {
  it("projects cold raw turns for empty-hot-session restore", () => {
    const rows = turnRecordsFromRawMaterials([
      {
        sessionId: "se_1",
        turns: [{ id: "tu_1", role: "user", content: "原话", intent: "", timestamp: "2026-06-27T00:00:00.000Z" }],
        strategyTrace: [],
        createdAt: "2026-06-27T00:00:00.000Z",
      },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "tu_1", sessionId: "se_1", content: "原话" });
  });
});
