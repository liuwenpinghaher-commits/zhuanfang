// Note → question promotion, post-interview feedback, and memory corrections.
// Split out of assets.ts (which now holds only asset-status operations) so each file
// stays cohesive. engine.ts is the single re-export hub for both.
import type {
  ProductState,
} from "./types";

import { makeId, nowIso, withAuditEvent } from "./utils";

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
        // "会后反馈"标记 + "正在聚焦"状态:让 findNextInterviewFocusQuestion 能选中它,
        // 把"会后保存的回访问题"真正接进下一次专访的聚焦点(否则该续问闭环永不触发)。
        whyImportant: `会后反馈:来自访谈《${note.title}》的下次回访问题。`,
        status: "正在聚焦",
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
