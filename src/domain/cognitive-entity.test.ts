import { describe, it, expect } from "vitest";
import {
  collectCognitiveEntities,
  collectDistillations,
  countRetrievableAssetCategory,
} from "./cognitive-entity";
import { createInitialProductState } from "./engine";
import type {
  DecisionAsset,
  DualTrackNote,
  KnowledgeDebt,
  LongTermTheme,
  MemoryRecord,
  PointAsset,
  ProductState,
  QuestionAsset,
} from "./types";

// 手工小状态:每类资产给可区分 id,便于断言"成员清单"而不依赖 demo seed 的具体条数。
// 覆盖全部资产类型(含 demo 里为空的 memoryRecords)。
function buildState(): ProductState {
  const base = createInitialProductState();
  const note: DualTrackNote = {
    id: "note-x",
    sessionId: "s1",
    title: "n",
    summary: "",
    keyQuote: "",
    saidTrack: [],
    learnedTrack: [],
    nextQuestions: [],
    createdAt: "2026-06-28T00:00:00.000Z",
  };
  const point: PointAsset = {
    id: "point-x",
    title: "p",
    content: "",
    status: "稳定观点",
    confidence: "用户确认",
    evidence: [],
    important: false,
    updatedAt: "2026-06-28T00:00:00.000Z",
  };
  const question: QuestionAsset = {
    id: "question-x",
    question: "q",
    whyImportant: "",
    status: "开放",
    appearances: 1,
    nextPrompt: "",
    important: false,
    updatedAt: "2026-06-28T00:00:00.000Z",
  };
  const decision: DecisionAsset = {
    id: "decision-x",
    title: "d",
    decisionKind: "用户决策",
    confirmationStatus: "用户确认",
    choice: "",
    tradeOff: "",
    riskHypothesis: "",
    reviewAt: "",
    status: "待复盘",
    updatedAt: "2026-06-28T00:00:00.000Z",
  };
  const debt: KnowledgeDebt = {
    id: "debt-x",
    concept: "c",
    context: "",
    whyImportant: "",
    status: "待了解",
    nextQuestion: "",
    updatedAt: "2026-06-28T00:00:00.000Z",
  };
  const theme: LongTermTheme = {
    id: "theme-x",
    name: "t",
    summary: "",
    maturity: "萌芽",
    representativeQuote: "",
    appearances: 1,
    nextQuestion: "",
    updatedAt: "2026-06-28T00:00:00.000Z",
  };
  const memory: MemoryRecord = {
    id: "memory-x",
    text: "m",
    status: "confirmed",
    sourceType: "profile",
    sourceId: "src",
    evidenceQuote: "",
    createdAt: "2026-06-28T00:00:00.000Z",
    updatedAt: "2026-06-28T00:00:00.000Z",
  };
  return {
    ...base,
    notes: [note],
    points: [point],
    questions: [question],
    decisions: [decision],
    debts: [debt],
    themes: [theme],
    memoryRecords: [memory],
  };
}

describe("collectDistillations", () => {
  it("gathers notes + points + decisions + debts (the Distillation siblings)", () => {
    const state = buildState();
    const ids = collectDistillations(state).map((e) => e.id);
    expect(ids).toEqual(["note-x", "point-x", "decision-x", "debt-x"]);
  });

  it("excludes Inquiry (question), Axis (theme) and Memory — they are not Distillations", () => {
    const state = buildState();
    const ids = collectDistillations(state).map((e) => e.id);
    expect(ids).not.toContain("question-x");
    expect(ids).not.toContain("theme-x");
    expect(ids).not.toContain("memory-x");
  });

  it("matches the sum of its source arrays on real demo data", () => {
    const state = createInitialProductState();
    expect(collectDistillations(state)).toHaveLength(
      state.notes.length + state.points.length + state.decisions.length + state.debts.length,
    );
  });

  it("is empty for an empty-ish state", () => {
    const state = { ...createInitialProductState(), notes: [], points: [], decisions: [], debts: [] };
    expect(collectDistillations(state)).toEqual([]);
  });
});

describe("collectCognitiveEntities", () => {
  it("gathers every cognitive-entity asset type (distillations + question + theme + memory)", () => {
    const state = buildState();
    const ids = collectCognitiveEntities(state).map((e) => e.id).sort();
    expect(ids).toEqual(
      ["note-x", "point-x", "decision-x", "debt-x", "question-x", "theme-x", "memory-x"].sort(),
    );
  });

  it("superset of collectDistillations by exactly question + theme + memory counts", () => {
    const state = buildState();
    expect(collectCognitiveEntities(state)).toHaveLength(
      collectDistillations(state).length +
        state.questions.length +
        state.themes.length +
        state.memoryRecords.length,
    );
  });

  it("every returned entity carries an id (the父类共性最小集)", () => {
    const state = buildState();
    for (const entity of collectCognitiveEntities(state)) {
      expect(typeof entity.id).toBe("string");
      expect(entity.id.length).toBeGreaterThan(0);
    }
  });
});

describe("countRetrievableAssetCategory", () => {
  it("counts point + question + decision + debt + theme (privacy/migration 'assets' category)", () => {
    const state = buildState();
    // 1 point + 1 question + 1 decision + 1 debt + 1 theme = 5; notes/memory deliberately excluded.
    expect(countRetrievableAssetCategory(state)).toBe(5);
  });

  it("does NOT count notes or memoryRecords (cross-taxonomy category boundary)", () => {
    const base = buildState();
    const withMoreNotesAndMemory: ProductState = {
      ...base,
      notes: [...base.notes, { ...base.notes[0], id: "note-y" }],
      memoryRecords: [...base.memoryRecords, { ...base.memoryRecords[0], id: "memory-y" }],
    };
    // adding notes/memory must not change the assets-category count
    expect(countRetrievableAssetCategory(withMoreNotesAndMemory)).toBe(
      countRetrievableAssetCategory(base),
    );
  });
});
