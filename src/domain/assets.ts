import type {
  AssetStatus,
  InterviewFeedbackInput,
  InterviewFeedbackTag,
  InterviewStrength,
  ProductState,
  SearchResult,
} from "./types";

import { cloneState, makeId, nowIso, withAuditEvent, withAiRunEvent } from "./utils";

function buildFeedbackCorrectionText(noteTitle: string, inaccurateSummary: string | undefined, tags: InterviewFeedbackTag[]) {
  if (!inaccurateSummary && !tags.includes("memory-wrong")) {
    return undefined;
  }
  return `会后反馈《${noteTitle}》：${inaccurateSummary ?? "用户标记 AI 记错了，需要下次避免重复这个理解。"}`;
}
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
            ...item,
            decisionKind: "用户决策",
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
export function createQuestionFromNote(state: ProductState, noteId: string, nextQuestionIndex: number): ProductState {
  const note = state.notes.find((item) => item.id === noteId);
  const question = note?.nextQuestions[nextQuestionIndex];
  if (!note || !question) {
    return state;
  }

  return {
    ...state,
    questions: [
      {
        id: makeId("question-from-note"),
        question,
        whyImportant: `来自访谈《${note.title}》的下次回访问题。`,
        status: "开放",
        appearances: 1,
        relatedThemeIds: ["theme-control"],
        nextPrompt: question,
        important: true,
        updatedAt: nowIso()
      },
      ...state.questions
    ]
  };
}
function deriveFeedbackStrength(current: InterviewStrength, tags: InterviewFeedbackTag[]): InterviewStrength {
  if (tags.includes("too-strong")) {
    return "gentle";
  }
  if (tags.includes("too-gentle") || tags.includes("went-deep")) {
    return "sharp";
  }
  if (tags.includes("off-track")) {
    return "standard";
  }
  return current;
}
export function markMemoryCorrection(state: ProductState, text: string): ProductState {
  const createdAt = nowIso();
  const correction = {
    id: makeId("correction"),
    text,
    createdAt
  };
  return withAuditEvent(
    {
      ...state,
      memoryCorrections: [correction, ...state.memoryCorrections]
    },
    {
      type: "memory_correction_created",
      label: "记忆修正已创建",
      detail: text,
      severity: "warning",
      entityType: "memory",
      entityId: correction.id,
      createdAt
    }
  );
}
function normalizeFeedbackTags(tags: InterviewFeedbackTag[]) {
  return Array.from(new Set(tags)).filter((tag): tag is InterviewFeedbackTag =>
    ["went-deep", "off-track", "too-gentle", "too-strong", "memory-wrong", "summary-accurate", "continue-next"].includes(tag)
  );
}
function normalizeOptionalFeedbackText(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
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
export function submitInterviewFeedback(
  state: ProductState,
  noteId: string,
  input: InterviewFeedbackInput
): ProductState {
  const note = state.notes.find((item) => item.id === noteId);
  if (!note) {
    return state;
  }

  const createdAt = nowIso();
  const tags = normalizeFeedbackTags(input.tags);
  const feedback = {
    id: makeId("interview-feedback"),
    noteId: note.id,
    sessionId: note.sessionId,
    tags,
    mostValuableQuestion: normalizeOptionalFeedbackText(input.mostValuableQuestion),
    inaccurateSummary: normalizeOptionalFeedbackText(input.inaccurateSummary),
    uncomfortableButImportant: normalizeOptionalFeedbackText(input.uncomfortableButImportant),
    newUnderstanding: normalizeOptionalFeedbackText(input.newUnderstanding),
    continuePrompt: normalizeOptionalFeedbackText(input.continuePrompt),
    createdAt
  };

  let nextState: ProductState = {
    ...cloneState(state),
    profile: {
      ...state.profile,
      preferredStrength: deriveFeedbackStrength(state.profile.preferredStrength, tags)
    },
    notes: state.notes.map((item) => (item.id === note.id ? { ...item, feedback } : item))
  };

  const correction = buildFeedbackCorrectionText(note.title, feedback.inaccurateSummary, tags);
  if (correction) {
    nextState = markMemoryCorrection(nextState, correction);
  }

  if (tags.includes("continue-next") && feedback.continuePrompt) {
    nextState = {
      ...nextState,
      questions: [
        {
          id: makeId("question-feedback"),
          question: feedback.continuePrompt,
          whyImportant: `来自会后反馈《${note.title}》，用户明确要求下次继续追问。`,
          status: "正在聚焦",
          appearances: 1,
          relatedThemeIds: ["theme-control"],
          nextPrompt: feedback.mostValuableQuestion ?? feedback.continuePrompt,
          important: true,
          updatedAt: createdAt
        },
        ...nextState.questions
      ]
    };
  }

  return withAuditEvent(nextState, {
    type: "interview_feedback_submitted",
    label: "会后反馈已记录",
    detail: `《${note.title}》收到 ${tags.length} 个反馈标签，后续专访将参考这些偏好。`,
    severity: tags.includes("memory-wrong") || tags.includes("off-track") ? "warning" : "info",
    entityType: "dual_track_note",
    entityId: note.id,
    createdAt
  });
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
      decision.id === decisionId
        ? {
            ...decision,
            status,
            updatedAt: nowIso()
          }
        : decision
    )
  };
}
export function updateKnowledgeDebtStatus(
  state: ProductState,
  debtId: string,
  status: Extract<AssetStatus, "待了解" | "能复述" | "已应用" | "不相关">
): ProductState {
  return {
    ...state,
    debts: state.debts.map((debt) =>
      debt.id === debtId
        ? {
            ...debt,
            status,
            updatedAt: nowIso()
          }
        : debt
    )
  };
}
export function updatePointStatus(
  state: ProductState,
  pointId: string,
  status: Extract<AssetStatus, "临时想法" | "稳定观点" | "被挑战中" | "已修正" | "已放弃">
): ProductState {
  return {
    ...state,
    points: state.points.map((point) =>
      point.id === pointId ? { ...point, status, confidence: "用户确认", updatedAt: nowIso() } : point
    )
  };
}
export function updateQuestionStatus(
  state: ProductState,
  questionId: string,
  status: Extract<AssetStatus, "开放" | "反复出现" | "正在聚焦" | "阶段性回答">
): ProductState {
  return {
    ...state,
    questions: state.questions.map((question) =>
      question.id === questionId ? { ...question, status, updatedAt: nowIso() } : question
    )
  };
}
