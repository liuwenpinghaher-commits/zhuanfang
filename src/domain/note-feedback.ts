// Note → question promotion, post-interview feedback, and memory corrections.
// Split out of assets.ts (which now holds only asset-status operations) so each file
// stays cohesive. engine.ts is the single re-export hub for both.
import type {
  InterviewFeedbackInput,
  InterviewFeedbackTag,
  InterviewStrength,
  ProductState,
} from "./types";

import { makeId, nowIso, withAuditEvent } from "./utils";

function buildFeedbackCorrectionText(noteTitle: string, inaccurateSummary: string | undefined, tags: InterviewFeedbackTag[]) {
  if (!inaccurateSummary && !tags.includes("memory-wrong")) {
    return undefined;
  }
  return `会后反馈《${noteTitle}》：${inaccurateSummary ?? "用户标记 AI 记错了，需要下次避免重复这个理解。"}`;
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
        // ponytail: inherit the source note's themes instead of hardcoding the
        // seed "control" theme; empty when the note has none, theme-tagging fills later.
        relatedThemeIds: note.relatedThemeIds ?? [],
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
    ...state,
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
          // ponytail: inherit the source note's themes, not the hardcoded seed theme.
          relatedThemeIds: note.relatedThemeIds ?? [],
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
