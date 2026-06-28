import { describe, it, expect } from "vitest";
import { createInitialProductState } from "./engine";
import { confirmDecisionCandidate } from "./assets";
import { upsertFinalizeDebts } from "./finalize";
import type { DecisionAsset, KnowledgeDebt, ProductState } from "./types";

describe("L2:confirmDecisionCandidate 保留 decisionKind 来源", () => {
  it("确认只改 confirmationStatus,decisionKind 不被覆盖(区分 AI 候选 vs 用户原创)", () => {
    const base = createInitialProductState();
    const decision: DecisionAsset = { id: "de_1", title: "t", decisionKind: "候选决策", confirmationStatus: "待用户确认", choice: "c", tradeOff: "", riskHypothesis: "", reviewAt: "", status: "待复盘", updatedAt: "2026-06-27T00:00:00.000Z", relatedThemeIds: [] };
    const state: ProductState = { ...base, decisions: [decision] };
    const updated = confirmDecisionCandidate(state, "de_1");
    expect(updated.decisions[0].confirmationStatus).toBe("用户确认");
    expect(updated.decisions[0].decisionKind).toBe("候选决策"); // 来源保留,非覆盖为"用户决策"
  });
});

describe("M3:upsertFinalizeDebts 债去重 + appearances", () => {
  it("同 concept(归一化)去重 + appearances 自增 + refresh 内容", () => {
    const existing: KnowledgeDebt[] = [{ id: "db_1", concept: "放权边界", context: "c1", whyImportant: "w", status: "待了解", nextQuestion: "q", updatedAt: "2026-06-27T00:00:00.000Z", appearances: 1 }];
    const incoming: KnowledgeDebt[] = [{ id: "db_2", concept: "放权边界 ", context: "c2", whyImportant: "w2", status: "待了解", nextQuestion: "q2", updatedAt: "x" }];
    const result = upsertFinalizeDebts(existing, incoming, "se_1", "2026-06-28T00:00:00.000Z");
    expect(result.length).toBe(1); // 同概念合并,不重复 prepend
    expect(result[0].appearances).toBe(2); // 反复欠债自增
    expect(result[0].context).toBe("c2"); // refresh 最新内容
  });
  it("不同 concept 新建,appearances=1 + 带 sourceSessionId", () => {
    const result = upsertFinalizeDebts([], [{ id: "db_1", concept: "新概念", context: "c", whyImportant: "w", status: "待了解", nextQuestion: "q", updatedAt: "x" }], "se_1", "2026-06-28T00:00:00.000Z");
    expect(result.length).toBe(1);
    expect(result[0].appearances).toBe(1);
    expect(result[0].sourceSessionId).toBe("se_1");
  });
});
