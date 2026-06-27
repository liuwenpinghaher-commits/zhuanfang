import { describe, it, expect } from "vitest";
import { createInitialProductState } from "./engine";
import { resolveInterviewTopicHint, buildInterviewGuide, buildInterviewContextPack, buildInterviewCard, createSessionDraft } from "./context-pack";
import type { ProductState } from "./types";
import type { RecallResult } from "./recall";

function theme(id: string, name: string, appearances: number) {
  return { id, name, summary: "", maturity: "聚焦" as const, representativeQuote: "", appearances, nextQuestion: "", updatedAt: "2026-06-27T00:00:00.000Z" };
}
function stateWith(over: Partial<ProductState> = {}): ProductState {
  return { ...createInitialProductState(), ...over };
}

describe("resolveInterviewTopicHint", () => {
  it("显式 topicHint 优先(且 trim)", () => {
    const s = stateWith({ themes: [theme("th_1", "放权", 5)] });
    expect(resolveInterviewTopicHint(s, { topicHint: "  授权边界 " })).toBe("授权边界");
  });
  it("无显式时回退到出现次数最高的主题名", () => {
    const s = stateWith({ themes: [theme("th_1", "放权", 2), theme("th_2", "复盘", 9)] });
    expect(resolveInterviewTopicHint(s, {})).toBe("复盘");
  });
  it("无主题/简报/聚焦问题时回退到 profile.currentFocus", () => {
    const base = createInitialProductState();
    const s: ProductState = { ...base, themes: [], searchBriefs: [], profile: { ...base.profile, currentFocus: "我的焦点XYZ" } };
    expect(resolveInterviewTopicHint(s, {})).toBe("我的焦点XYZ");
  });
});

function linkedRecallState(): ProductState {
  const base = createInitialProductState();
  return { ...base,
    themes: [theme("th_1", "放权", 9)],
    points: [
      { id: "pt_1", title: "挂主题观点", content: "c1", status: "稳定观点" as const, confidence: "用户确认" as const, evidence: [], relatedThemeIds: ["th_1"], important: false, updatedAt: "2026-06-27T00:00:00.000Z" },
      { id: "pt_off", title: "不挂主题观点", content: "c2", status: "稳定观点" as const, confidence: "用户确认" as const, evidence: [], relatedThemeIds: [], important: false, updatedAt: "2026-06-27T00:00:00.000Z" }
    ],
    decisions: [{ id: "de_1", title: "挂主题决策", decisionKind: "用户决策" as const, confirmationStatus: "用户确认" as const, choice: "ch", tradeOff: "", riskHypothesis: "", reviewAt: "", status: "待复盘" as const, updatedAt: "2026-06-27T00:00:00.000Z", relatedThemeIds: ["th_1"] }],
    memoryRecords: [
      { id: "me_a", text: "记忆A", status: "confirmed" as const, sourceType: "profile" as const, sourceId: "p", evidenceQuote: "", sensitivity: "normal" as const, createdAt: "2026-06-27T00:00:00.000Z", updatedAt: "2026-06-27T00:00:00.000Z" },
      { id: "me_b", text: "记忆B", status: "confirmed" as const, sourceType: "profile" as const, sourceId: "p", evidenceQuote: "", sensitivity: "normal" as const, createdAt: "2026-06-27T00:00:00.000Z", updatedAt: "2026-06-27T00:00:00.000Z" }
    ]
  } as ProductState;
}

describe("collectRelevantMemories: recall 消费(经 guide)", () => {
  it("有 themeAssets:主题资产精确召回(含 decisions),不混入未挂主题资产", () => {
    const recall: RecallResult = { themeAssets: { points: ["pt_1"], decisions: ["de_1"], questions: [], memories: [] } };
    const guide = buildInterviewGuide(linkedRecallState(), { topicHint: "放权" }, recall);
    const joined = guide.relevantMemories.join(" | ");
    expect(joined).toContain("挂主题决策");
    expect(joined).toContain("挂主题观点");
    expect(joined).not.toContain("不挂主题观点");
  });
  it("有 memoryHits:仅候选 id 进入记忆池(me_b 命中,me_a 不命中)", () => {
    const recall: RecallResult = { memoryHits: [{ id: "me_b", text: "记忆B" }] };
    const guide = buildInterviewGuide(linkedRecallState(), { topicHint: "放权" }, recall);
    expect(guide.relevantMemories).toContain("记忆B");
    expect(guide.relevantMemories).not.toContain("记忆A");
  });
  it("无 recall:回落等价(两条记忆都在候选)", () => {
    const guide = buildInterviewGuide(linkedRecallState(), { topicHint: "放权" });
    const joined = guide.relevantMemories.join(" | ");
    expect(joined).toContain("记忆A");
    expect(joined).toContain("记忆B");
  });
});

describe("buildInterviewContextPack: recall 消费", () => {
  it("有 memoryHits:confirmedMemories 仅含候选并精排", () => {
    const pack = buildInterviewContextPack(linkedRecallState(), { topicHint: "放权" }, { memoryHits: [{ id: "me_b", text: "记忆B" }] });
    expect(pack.confirmedMemories).toContain("记忆B");
    expect(pack.confirmedMemories).not.toContain("记忆A");
  });
  it("有 provenance:provenanceTurns 透出;无则 undefined", () => {
    const prov = [{ assetTable: "point", assetId: "pt_1", turns: [{ id: "tu_1", content: "原话", sessionId: "se_1", role: "user" }] }];
    const pack = buildInterviewContextPack(linkedRecallState(), { topicHint: "放权" }, { provenance: prov });
    expect(pack.provenanceTurns?.[0]?.turns[0]?.content).toBe("原话");
    expect(buildInterviewContextPack(linkedRecallState(), { topicHint: "放权" }).provenanceTurns).toBeUndefined();
  });
});

describe("card / createSessionDraft 透传 recall + 溯源", () => {
  it("buildInterviewCard:provenance 原话进入 historyReferences", () => {
    const recall: RecallResult = { provenance: [{ assetTable: "point", assetId: "pt_1", turns: [{ id: "tu_1", content: "受访者原话XYZ", sessionId: "se_1", role: "user" }] }] };
    const card = buildInterviewCard(linkedRecallState(), undefined, "放权", undefined, recall);
    expect(card.historyReferences.some((h) => h.includes("受访者原话XYZ"))).toBe(true);
  });
  it("createSessionDraft:recall 透传到 guide(themeAssets 决策可见)", () => {
    const recall: RecallResult = { themeAssets: { points: ["pt_1"], decisions: ["de_1"], questions: [], memories: [] } };
    const session = createSessionDraft(linkedRecallState(), "daily", "standard", { topicHint: "放权", recall });
    expect(session.guide.relevantMemories.join(" | ")).toContain("挂主题决策");
  });
  it("不传 recall:card 同步可用(行为不变)", () => {
    const card = buildInterviewCard(linkedRecallState(), undefined, "放权");
    expect(typeof card.title).toBe("string");
  });
});
