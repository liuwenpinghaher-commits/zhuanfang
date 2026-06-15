import type {
  DecisionAsset,
  DualTrackNote,
  FinalizeResult,
  InterviewSession,
  KnowledgeDebt,
  LongTermTheme,
  MemoryCandidate,
  PointAsset,
  ProductState,
  QuestionAsset,
  SearchBrief,
} from "./types";

import { cloneState, makeId, nowIso, withAuditEvent, withAiRunEvent, extractAnchor } from "./utils";
import { withMemoryCandidateReview } from "./memoryReview";
import { buildInterviewQualityReport, tokenizeMemoryGraphText } from "./engine";
import { uniqueStrings } from "./signals";

function buildMemoryCandidateFromSession(
  session: InterviewSession,
  note: DualTrackNote,
  keyQuote: string,
  createdAt: string
): MemoryCandidate {
  const anchor = extractAnchor(keyQuote);
  const text = `用户反复关注“${anchor}”背后的判断责任和机制代价。`;
  return withMemoryCandidateReview({
    id: makeId("memory-candidate"),
    text,
    status: "pending",
    sourceType: "interview_session",
    sourceId: session.id,
    evidenceQuote: keyQuote,
    reason: `来自会后双轨笔记《${note.title}》，需要用户确认后才进入长期记忆。`,
    sensitivity: keyQuote.includes("不满") || keyQuote.includes("否定") ? "sensitive" : "normal",
    createdAt
  });
}
/** A theme upsert produced by either the deterministic or the LLM finalize path. */
export interface FinalizeThemeUpsert {
  id?: string;
  name: string;
  summary: string;
  representativeQuote: string;
  nextQuestion: string;
  maturity: LongTermTheme["maturity"];
}

/**
 * Fully-formed finalize content (note + assets), produced by either the
 * deterministic builder or the LLM. mergeFinalizedState turns it into state.
 */
export interface FinalizeContent {
  note: DualTrackNote;
  points: PointAsset[];
  questions: QuestionAsset[];
  decisions: DecisionAsset[];
  debts: KnowledgeDebt[];
  themes: FinalizeThemeUpsert[];
}

export function finalizeSession(state: ProductState, session: InterviewSession): FinalizeResult {
  const completedAt = nowIso();
  const content = buildDeterministicFinalizeContent(session, completedAt);
  return mergeFinalizedState(state, session, content, completedAt);
}

/**
 * Deterministic, offline fallback content. Anchored on the "救火/授权" demo
 * scenario — only keyQuote reflects real input. Used when no LLM is available.
 */
function buildDeterministicFinalizeContent(session: InterviewSession, completedAt: string): FinalizeContent {
  const userTurns = session.turns.filter((turn) => turn.role === "user");
  const assistantTurns = session.turns.filter((turn) => turn.role === "assistant");
  const keyQuote = pickKeyQuote(userTurns.map((turn) => turn.content));
  const anchor = extractAnchor(keyQuote);

  const note: DualTrackNote = {
    id: makeId("note"),
    sessionId: session.id,
    title: session.title,
    summary: `这次访谈把“${anchor}”从一个情绪化表达推进到了责任边界和机制代价的问题。`,
    keyQuote,
    saidTrack: [
      keyQuote,
      "用户不只是想减少介入，也在担心放手后的短期风险。",
      "用户开始把问题从个人能力转向机制和责任分配。"
    ],
    learnedTrack: [
      "真正的分歧可能不是要不要救火，而是能不能承受不救火的代价。",
      "如果机制一直奖励等待用户拍板，团队很难自然承担判断。",
      "下次需要把“最坏情况”拆成可验证的风险，而不是笼统的失控。"
    ],
    nextQuestions: [
      "如果你不亲自救火，最坏会发生什么？",
      "你愿意用哪一个小范围项目测试放手？"
    ],
    createdAt: completedAt
  };

  if (!session.doNotSave && assistantTurns.length === 0) {
    note.learnedTrack.push("本次没有形成足够的 AI 追问，应标记为轻量记录。");
  }

  const points: PointAsset[] = [
    {
      id: makeId("point"),
      title: "我需要重新定义救火和授权的边界",
      content: "继续兜底能降低短期风险，但会延长团队对我拍板的依赖。",
      status: "被挑战中",
      confidence: "待验证",
      evidence: [keyQuote],
      relatedThemeIds: ["theme-control"],
      important: true,
      updatedAt: completedAt
    }
  ];

  const questions: QuestionAsset[] = [
    {
      id: makeId("question"),
      question: "如果我不救火，最坏会发生什么？",
      whyImportant: "这个问题决定用户能否从抽象授权推进到真实代价评估。",
      status: "正在聚焦",
      appearances: 1,
      relatedThemeIds: ["theme-control"],
      nextPrompt: "把最坏情况拆成延期、质量、客户、团队信任四类风险。",
      important: true,
      updatedAt: completedAt
    }
  ];

  const decisions: DecisionAsset[] = [
    {
      id: makeId("decision"),
      title: "是否继续亲自救火",
      decisionKind: "候选决策",
      confirmationStatus: "待用户确认",
      choice: "候选低成本验证路径：先选一个低风险项目减少直接兜底。",
      tradeOff: "短期会暴露团队判断缺口，但能验证机制是否真的可承压。",
      riskHypothesis: "没有用户兜底时，项目可能延期，但团队会更快暴露真正缺口。",
      reviewAt: "2026-07-10",
      status: "待复盘",
      updatedAt: completedAt
    }
  ];

  const debts: KnowledgeDebt[] = [
    {
      id: makeId("debt"),
      concept: "授权机制",
      context: "本次访谈中，用户把救火和团队承担判断联系起来。",
      whyImportant: "它能帮助用户区分“给任务”和“给判断权”。",
      status: "待了解",
      nextQuestion: "你能不能用一个项目例子说明什么叫真正授权？",
      updatedAt: completedAt
    }
  ];

  const themes: FinalizeThemeUpsert[] = [
    {
      id: "theme-control",
      name: "控制感",
      summary: "用户正在探索放手、授权和短期失控之间的关系。",
      representativeQuote: keyQuote,
      nextQuestion: "如果你允许短期失控，最坏会发生什么？",
      maturity: "聚焦"
    }
  ];

  return { note, points, questions, decisions, debts, themes };
}

/**
 * Shared state-plumbing for finalize: completes the session, prepends the note
 * and assets, records the memory candidate, marks the source brief applied,
 * upserts themes by name, and emits audit/AI-run events. Used by BOTH the
 * deterministic path and the LLM path so they stay behaviourally identical
 * apart from the content.
 */
export function mergeFinalizedState(
  state: ProductState,
  session: InterviewSession,
  content: FinalizeContent,
  completedAt: string
): FinalizeResult {
  const { note } = content;
  const completedSession: InterviewSession = {
    ...session,
    status: "completed",
    completedAt,
    qualityReport: buildInterviewQualityReport(session)
  };

  if (session.doNotSave) {
    const nextState = withInterviewFinalizedEvents(
      {
        ...cloneState(state),
        sessions: [completedSession, ...state.sessions]
      },
      completedSession,
      note,
      completedAt
    );

    return { note, nextState };
  }

  const nextState = cloneState(state);
  const memoryCandidate = buildMemoryCandidateFromSession(session, note, note.keyQuote, completedAt);
  nextState.sessions = [completedSession, ...nextState.sessions];
  nextState.searchBriefs = markSearchBriefAppliedToSession(nextState.searchBriefs, completedSession);
  nextState.notes = [note, ...nextState.notes];
  nextState.memoryCandidates = [memoryCandidate, ...(nextState.memoryCandidates ?? [])];
  nextState.points = [...content.points, ...nextState.points];
  nextState.questions = [...content.questions, ...nextState.questions];
  nextState.decisions = [...content.decisions, ...nextState.decisions];
  nextState.debts = [...content.debts, ...nextState.debts];
  nextState.themes = upsertFinalizeThemes(nextState.themes, content.themes, completedAt);

  return {
    note,
    nextState: withInterviewFinalizedEvents(nextState, completedSession, note, completedAt)
  };
}

/** Upsert each theme by name: update appearances/quote/maturity if it exists, else prepend. */
function upsertFinalizeThemes(
  existingThemes: LongTermTheme[],
  upserts: FinalizeThemeUpsert[],
  completedAt: string
): LongTermTheme[] {
  let themes = existingThemes;
  for (const upsert of upserts) {
    if (themes.some((theme) => theme.name === upsert.name)) {
      themes = themes.map((theme) =>
        theme.name === upsert.name
          ? {
              ...theme,
              maturity: upsert.maturity,
              appearances: theme.appearances + 1,
              representativeQuote: upsert.representativeQuote,
              nextQuestion: upsert.nextQuestion,
              updatedAt: completedAt
            }
          : theme
      );
    } else {
      themes = [
        {
          id: upsert.id ?? makeId("theme"),
          name: upsert.name,
          summary: upsert.summary,
          maturity: upsert.maturity,
          representativeQuote: upsert.representativeQuote,
          appearances: 1,
          nextQuestion: upsert.nextQuestion,
          updatedAt: completedAt
        },
        ...themes
      ];
    }
  }
  return themes;
}
function findReferencedMemoryRecord(state: ProductState, memoryText: string) {
  const exactMatch = state.memoryRecords.find(
    (record) =>
      record.status === "confirmed" &&
      (record.text === memoryText ||
        memoryText.includes(record.text) ||
        record.text.includes(memoryText) ||
        record.evidenceQuote === memoryText)
  );
  if (exactMatch) {
    return exactMatch;
  }

  const referenceTokens = tokenizeMemoryGraphText(memoryText);
  return state.memoryRecords
    .filter((record) => record.status === "confirmed")
    .map((record) => {
      const recordTokens = tokenizeMemoryGraphText(`${record.text} ${record.evidenceQuote}`);
      const overlap = Array.from(referenceTokens).filter((token) => recordTokens.has(token));
      const score = overlap.reduce((total, token) => total + (token.length >= 3 ? 1.5 : 1), 0);
      return { record, score };
    })
    .filter((item) => item.score >= 2)
    .sort((a, b) => b.score - a.score)[0]?.record;
}
function makeStableMemoryReferenceId(memoryText: string) {
  const normalized = memoryText.replace(/\s+/g, "").slice(0, 24);
  return normalized ? `memory-reference-${normalized}` : "memory-reference-unknown";
}
function markSearchBriefAppliedToSession(searchBriefs: SearchBrief[], session: InterviewSession) {
  const searchBriefId = session.card.searchBriefId;
  if (!searchBriefId) {
    return searchBriefs;
  }

  return searchBriefs.map((brief) => {
    if (brief.id !== searchBriefId || brief.appliedToSessionIds.includes(session.id)) {
      return brief;
    }
    return {
      ...brief,
      appliedToSessionIds: [session.id, ...brief.appliedToSessionIds]
    };
  });
}
function pickKeyQuote(quotes: string[]): string {
  return (
    quotes
      .filter(Boolean)
      .sort((a, b) => scoreQuote(b) - scoreQuote(a))[0] ?? "这次我还没有说清楚真正的问题。"
  );
}
function scoreQuote(quote: string): number {
  const signalWords = ["不是", "兜底", "救火", "最坏", "失控", "判断", "机制", "责任"];
  return quote.length + signalWords.filter((word) => quote.includes(word)).length * 20;
}
function withInterviewFinalizedEvents(
  state: ProductState,
  session: InterviewSession,
  note: DualTrackNote,
  createdAt: string
): ProductState {
  const score = session.qualityReport?.score ?? 0;
  const stateWithMemoryReferenceEvents = withMemoryReferencedAuditEvents(state, session, createdAt);
  return withAiRunEvent(
    withAuditEvent(stateWithMemoryReferenceEvents, {
      type: "interview_session_finalized",
      label: session.doNotSave ? "专访已结束但未写入长期资产" : "专访已结束并沉淀资产",
      detail: `《${session.title}》生成双轨笔记《${note.title}》，质量分 ${score}。`,
      severity: score >= 80 ? "info" : "warning",
      entityType: "interview_session",
      entityId: session.id,
      createdAt
    }),
    {
      workflow: "interview_quality_scoring",
      providerId: "deterministic-engine",
      status: "succeeded",
      entityType: "interview_session",
      entityId: session.id,
      inputSummary: `会话轮次：${session.turns.length}`,
      outputSummary: `质量分 ${score}，通过 ${session.qualityReport?.gates.filter((gate) => gate.passed).length ?? 0} 个质量门。`,
      latencyMs: 1,
      createdAt
    }
  );
}
function withMemoryReferencedAuditEvents(state: ProductState, session: InterviewSession, createdAt: string): ProductState {
  const referencedMemories = uniqueStrings(
    session.turns
      .filter((turn) => turn.role === "assistant")
      .map((turn) => turn.referencedMemory?.trim() ?? "")
  );

  return referencedMemories.reduce((nextState, memoryText) => {
    const record = findReferencedMemoryRecord(nextState, memoryText);
    return withAuditEvent(nextState, {
      type: "memory_referenced",
      label: "专访引用长期记忆",
      detail: `《${session.title}》引用：${memoryText}`,
      severity: "info",
      entityType: record ? "memory_record" : "memory",
      entityId: record?.id ?? makeStableMemoryReferenceId(memoryText),
      createdAt
    });
  }, state);
}
