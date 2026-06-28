// Asset-status operations: confirm/review decisions, toggle importance, update the
// status of points/questions/debts, and cross-asset search. Note→question promotion,
// post-interview feedback, and memory corrections live in note-feedback.ts.
import type {
  DebtStatus,
  PointStatus,
  ProductState,
  QuestionStatus,
  SearchResult,
} from "./types";

import { nowIso, withAuditEvent } from "./utils";

export function confirmDecisionCandidate(state: ProductState, decisionId: string): ProductState {
  const decision = state.decisions.find((item) => item.id === decisionId);
  if (!decision || decision.confirmationStatus === "用户确认") {
    return state;
  }

  const confirmedAt = nowIso();
  const nextState: ProductState = {
    ...state,
    decisions: state.decisions.map((item) =>
      item.id === decisionId
        ? {
            // 审查修复(L2):确认只改 confirmationStatus,保留 decisionKind 来源标记
            // (从而区分"用户原创决策"与"已确认的 AI 候选决策"),不再把来源覆盖成"用户决策"。
            ...item,
            confirmationStatus: "用户确认",
            updatedAt: confirmedAt
          }
        : item
    )
  };

  return withAuditEvent(nextState, {
    type: "decision_candidate_confirmed",
    label: "决策候选已确认",
    detail: decision.title,
    severity: "info",
    entityType: "decision",
    entityId: decision.id,
    createdAt: confirmedAt
  });
}

export function searchProductAssets(state: ProductState, query: string): SearchResult {
  const normalized = query.trim().toLowerCase();
  const match = (values: string[]) =>
    !normalized || values.some((value) => value.toLowerCase().includes(normalized));

  const notes = state.notes.filter((note) =>
    match([note.title, note.summary, note.keyQuote, ...note.saidTrack, ...note.learnedTrack, ...note.nextQuestions])
  );
  const points = state.points.filter((point) =>
    match([point.title, point.content, point.status, point.confidence, ...point.evidence])
  );
  const questions = state.questions.filter((question) =>
    match([question.question, question.whyImportant, question.status, question.nextPrompt])
  );
  const decisions = state.decisions.filter((decision) =>
    match([
      decision.title,
      decision.decisionKind,
      decision.confirmationStatus,
      decision.choice,
      decision.tradeOff,
      decision.riskHypothesis,
      decision.status
    ])
  );
  const debts = state.debts.filter((debt) =>
    match([debt.concept, debt.context, debt.whyImportant, debt.status, debt.nextQuestion])
  );
  const themes = state.themes.filter((theme) =>
    match([theme.name, theme.summary, theme.maturity, theme.representativeQuote, theme.nextQuestion])
  );

  return {
    query,
    total: notes.length + points.length + questions.length + decisions.length + debts.length + themes.length,
    notes,
    points,
    questions,
    decisions,
    debts,
    themes
  };
}

export function toggleAssetImportance(state: ProductState, assetId: string): ProductState {
  return {
    ...state,
    points: state.points.map((point) =>
      point.id === assetId ? { ...point, important: !point.important, updatedAt: nowIso() } : point
    ),
    questions: state.questions.map((question) =>
      question.id === assetId ? { ...question, important: !question.important, updatedAt: nowIso() } : question
    )
  };
}

export function updateDecisionStatus(
  state: ProductState,
  decisionId: string,
  status: "待复盘" | "已复盘"
): ProductState {
  return {
    ...state,
    decisions: state.decisions.map((decision) =>
      decision.id === decisionId ? { ...decision, status, updatedAt: nowIso() } : decision
    )
  };
}

export function updateKnowledgeDebtStatus(state: ProductState, debtId: string, status: DebtStatus): ProductState {
  return {
    ...state,
    debts: state.debts.map((debt) =>
      debt.id === debtId ? { ...debt, status, updatedAt: nowIso() } : debt
    )
  };
}

export function updatePointStatus(state: ProductState, pointId: string, status: PointStatus): ProductState {
  return {
    ...state,
    points: state.points.map((point) =>
      // ponytail: status and confidence are orthogonal — a status change must not
      // forge the confidence field. Confidence is owned by LLM extraction / a
      // dedicated action, not by status toggles.
      point.id === pointId ? { ...point, status, updatedAt: nowIso() } : point
    )
  };
}

export function updateQuestionStatus(state: ProductState, questionId: string, status: QuestionStatus): ProductState {
  return {
    ...state,
    questions: state.questions.map((question) =>
      question.id === questionId ? { ...question, status, updatedAt: nowIso() } : question
    )
  };
}
