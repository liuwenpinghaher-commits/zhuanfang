import { describe, it, expect } from "vitest";
import { checkAxioms, type AxiomViolation } from "./axioms";
import { createEmptyProductState } from "./engine";
import type {
  DecisionAsset,
  KnowledgeDebt,
  LongTermTheme,
  MemoryRecord,
  PointAsset,
  ProductState,
} from "./types";

// ── fixtures (minimal-but-valid; spread onto an empty initial state) ──────────
const ANCHOR = { sessionId: "se_1", turnId: "tu_1" };

function point(over: Partial<PointAsset> = {}): PointAsset {
  return {
    id: "pt_1", title: "观点", content: "c", status: "稳定观点", confidence: "用户确认",
    evidence: [], important: false, updatedAt: "2026-06-27T00:00:00.000Z",
    evidenceAnchors: [ANCHOR], ...over,
  };
}
function decision(over: Partial<DecisionAsset> = {}): DecisionAsset {
  return {
    id: "de_1", title: "决策", decisionKind: "用户决策", confirmationStatus: "用户确认",
    choice: "c", tradeOff: "", riskHypothesis: "", reviewAt: "", status: "待复盘",
    updatedAt: "2026-06-27T00:00:00.000Z", evidenceAnchors: [ANCHOR], ...over,
  };
}
function debt(over: Partial<KnowledgeDebt> = {}): KnowledgeDebt {
  return {
    id: "dt_1", concept: "概念", context: "", whyImportant: "", status: "待了解",
    nextQuestion: "", updatedAt: "2026-06-27T00:00:00.000Z", evidenceAnchors: [ANCHOR], ...over,
  };
}
function theme(over: Partial<LongTermTheme> = {}): LongTermTheme {
  return {
    id: "th_1", name: "主题", summary: "", maturity: "萌芽", representativeQuote: "",
    appearances: 1, nextQuestion: "", updatedAt: "2026-06-27T00:00:00.000Z", ...over,
  };
}
function memory(over: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "me_1", text: "记忆", status: "confirmed", sourceType: "profile", sourceId: "p",
    evidenceQuote: "", sensitivity: "normal", createdAt: "2026-06-27T00:00:00.000Z",
    updatedAt: "2026-06-27T00:00:00.000Z", ...over,
  };
}
function stateWith(over: Partial<ProductState>): ProductState {
  return { ...createEmptyProductState(), ...over };
}
function only(violations: AxiomViolation[], axiom: AxiomViolation["axiom"]): AxiomViolation[] {
  return violations.filter((v) => v.axiom === axiom);
}

describe("A1 · 每个 Distillation 需有 evidenceAnchors(无溯源=幻觉)", () => {
  it("无 evidenceAnchors 的 point → 违例(标 entityType/entityId)", () => {
    const v = only(checkAxioms(stateWith({ points: [point({ evidenceAnchors: [] })] })), "A1");
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ axiom: "A1", entityType: "point", entityId: "pt_1" });
  });
  it("缺省 evidenceAnchors(undefined)的 decision → 违例", () => {
    const v = only(checkAxioms(stateWith({ decisions: [decision({ evidenceAnchors: undefined })] })), "A1");
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ axiom: "A1", entityType: "decision", entityId: "de_1" });
  });
  it("无 evidenceAnchors 的 debt → 违例", () => {
    const v = only(checkAxioms(stateWith({ debts: [debt({ evidenceAnchors: [] })] })), "A1");
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ axiom: "A1", entityType: "debt", entityId: "dt_1" });
  });
  it("有 ≥1 条 evidenceAnchors → 放行(point/decision/debt)", () => {
    const state = stateWith({ points: [point()], decisions: [decision()], debts: [debt()] });
    expect(only(checkAxioms(state), "A1")).toHaveLength(0);
  });
});

describe("A2 · Theme.maturity ≤ f(appearances)(涌现属性)", () => {
  it("appearances=1 却标 成型 → 违例(超出 clamp 天花板)", () => {
    const v = only(checkAxioms(stateWith({ themes: [theme({ maturity: "成型", appearances: 1 })] })), "A2");
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ axiom: "A2", entityType: "theme", entityId: "th_1" });
  });
  it("appearances=1 且 萌芽 → 放行", () => {
    expect(only(checkAxioms(stateWith({ themes: [theme({ maturity: "萌芽", appearances: 1 })] })), "A2")).toHaveLength(0);
  });
  it("appearances=4 且 成型 → 放行(天花板内)", () => {
    expect(only(checkAxioms(stateWith({ themes: [theme({ maturity: "成型", appearances: 4 })] })), "A2")).toHaveLength(0);
  });
});

describe("A3 · llm_extracted 未经确认不得当事实(HITL 门控)", () => {
  it("非 confirmed(deprecated)记忆派生了 ragChunk → 违例(未确认/已弃用却进召回索引)", () => {
    const state = stateWith({
      memoryRecords: [memory({ status: "deprecated" })],
      ragChunks: [{
        id: "rc_1", sourceId: "me_1", title: "", text: "弃用", keywords: [],
        tokenEstimate: 1, usage: "interview-context", createdAt: "2026-06-27T00:00:00.000Z",
      }],
    });
    const v = only(checkAxioms(state), "A3");
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ axiom: "A3", entityType: "memory_record", entityId: "me_1" });
  });
  it("非 confirmed 记忆但未派生任何索引块 → 放行(HITL/生命周期正常态,不刷审计噪音)", () => {
    expect(only(checkAxioms(stateWith({ memoryRecords: [memory({ status: "deprecated" })] })), "A3")).toHaveLength(0);
    expect(only(checkAxioms(stateWith({ memoryRecords: [memory({ status: "deleted" })] })), "A3")).toHaveLength(0);
  });
  it("confirmed 记忆派生索引块 → 放行", () => {
    const state = stateWith({
      memoryRecords: [memory({ status: "confirmed" })],
      ragChunks: [{
        id: "rc_1", sourceId: "me_1", title: "", text: "已确认", keywords: [],
        tokenEstimate: 1, usage: "interview-context", createdAt: "2026-06-27T00:00:00.000Z",
      }],
    });
    expect(only(checkAxioms(state), "A3")).toHaveLength(0);
  });
});

describe("A4 · 敏感记忆不应出现在公开召回/索引(对齐 isModelSafeMemoryRecord)", () => {
  it("confirmed 但 sensitive 的记忆派生了 ragChunk(usage=interview-context)→ 违例", () => {
    const state = stateWith({
      memoryRecords: [memory({ id: "me_s", sensitivity: "sensitive" })],
      ragChunks: [{
        id: "rc_1", sourceId: "me_s", title: "", text: "敏感", keywords: [],
        tokenEstimate: 1, usage: "interview-context", createdAt: "2026-06-27T00:00:00.000Z",
      }],
    });
    const v = only(checkAxioms(state), "A4");
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ axiom: "A4", entityType: "memory_record", entityId: "me_s" });
  });
  it("敏感记忆但未派生任何索引块 → 放行(天然不被召回)", () => {
    const state = stateWith({ memoryRecords: [memory({ id: "me_s", sensitivity: "sensitive" })] });
    expect(only(checkAxioms(state), "A4")).toHaveLength(0);
  });
  it("normal 记忆派生索引块 → 放行", () => {
    const state = stateWith({
      memoryRecords: [memory({ id: "me_n", sensitivity: "normal" })],
      ragChunks: [{
        id: "rc_1", sourceId: "me_n", title: "", text: "普通", keywords: [],
        tokenEstimate: 1, usage: "interview-context", createdAt: "2026-06-27T00:00:00.000Z",
      }],
    });
    expect(only(checkAxioms(state), "A4")).toHaveLength(0);
  });
  it("policy includeSensitiveMemoriesInContext 开启时,敏感记忆派生块不算违例(对齐现行门控)", () => {
    const base = createEmptyProductState();
    const state: ProductState = {
      ...base,
      systemConfig: { ...base.systemConfig, memory: { ...base.systemConfig.memory, includeSensitiveMemoriesInContext: true } },
      memoryRecords: [memory({ id: "me_s", sensitivity: "sensitive" })],
      ragChunks: [{
        id: "rc_1", sourceId: "me_s", title: "", text: "敏感", keywords: [],
        tokenEstimate: 1, usage: "interview-context", createdAt: "2026-06-27T00:00:00.000Z",
      }],
    };
    expect(only(checkAxioms(state), "A4")).toHaveLength(0);
  });
});

describe("checkAxioms 综合", () => {
  it("空/初始 state 无违例", () => {
    expect(checkAxioms(createEmptyProductState())).toEqual([]);
  });
  it("一处状态可同时触发多条不同公理违例", () => {
    const state = stateWith({
      points: [point({ evidenceAnchors: [] })],                          // A1
      themes: [theme({ maturity: "成型", appearances: 1 })],             // A2
      memoryRecords: [memory({ status: "deprecated" })],                 // A3: 弃用记忆…
      ragChunks: [{                                                       // …却派生了召回索引块
        id: "rc_1", sourceId: "me_1", title: "", text: "弃用", keywords: [],
        tokenEstimate: 1, usage: "interview-context", createdAt: "2026-06-27T00:00:00.000Z",
      }],
    });
    const axioms = new Set(checkAxioms(state).map((v) => v.axiom));
    expect(axioms).toEqual(new Set(["A1", "A2", "A3"]));
  });
});
