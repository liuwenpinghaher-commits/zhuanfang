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

import { cloneState, makeId, nowIso, withAuditEvent, withAiRunEvent } from "./utils";
import { withMemoryCandidateReview } from "./memoryReview";
import { buildInterviewQualityReport, planMemoryUpdate, tokenizeMemoryGraphText } from "./engine";
import { uniqueStrings } from "./signals";

/**
 * M2 (Task 6): tag each fresh candidate with an extract-then-update dedup hint
 * against already-confirmed memories, so the HITL reviewer sees "似已有记忆 X".
 * Pure: candidates carry no embedding at finalize time, so planMemoryUpdate uses
 * its token-overlap fallback. Never mutates the store — only annotates candidates.
 */
function annotateCandidatesWithDedupHint(
  candidates: MemoryCandidate[],
  records: ProductState["memoryRecords"]
): MemoryCandidate[] {
  if (!records || records.length === 0) {
    return candidates;
  }
  return candidates.map((candidate) => {
    const plan = planMemoryUpdate({ text: candidate.text }, records);
    if (plan.op === "update" && plan.similarToRecordId) {
      return { ...candidate, suggestedUpdate: "update", similarToRecordId: plan.similarToRecordId };
    }
    return { ...candidate, suggestedUpdate: "add" };
  });
}

function buildMemoryCandidateFromSession(
  session: InterviewSession,
  note: DualTrackNote,
  keyQuote: string,
  createdAt: string
): MemoryCandidate {
  // Derive salient text from actual user turns rather than a fixed template.
  // Take the last 1-2 user turns as the primary source; fall back to keyQuote.
  const userTurns = session.turns.filter((t) => t.role === "user");
  const recentUserContents = userTurns.slice(-2).map((t) => t.content.trim()).filter(Boolean);
  const salient = recentUserContents.length
    ? recentUserContents.join("…")
    : keyQuote;
  // Cap at ~160 chars to keep the candidate compact.
  const truncated = salient.length > 160 ? salient.slice(0, 157) + "…" : salient;
  const text = `用户在《${note.title}》中表达：${truncated}`;
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

export function finalizeSession(
  state: ProductState,
  session: InterviewSession,
  providedCandidates?: MemoryCandidate[]
): FinalizeResult {
  const completedAt = nowIso();
  const content = buildDeterministicFinalizeContent(session, completedAt);
  return mergeFinalizedState(state, session, content, completedAt, providedCandidates);
}

/**
 * Deterministic, offline fallback content. Scenario-agnostic: fabricates
 * nothing. Preserves the user's own words and marks the record as a light
 * (degraded) record so the user knows AI synthesis was unavailable.
 */
function buildDeterministicFinalizeContent(session: InterviewSession, completedAt: string): FinalizeContent {
  const userTurns = session.turns.filter((turn) => turn.role === "user");
  const keyQuote = pickKeyQuote(userTurns.map((turn) => turn.content));
  const saidTrack = userTurns.slice(-3).map((turn) => turn.content).filter(Boolean);

  const note: DualTrackNote = {
    id: makeId("note"),
    sessionId: session.id,
    title: session.title,
    // ponytail: flag the degraded path in the prominent summary line so empty asset
    // counts read as "AI offline", not a bug. learnedTrack below repeats the detail.
    summary: `【轻量记录·未生成资产】${keyQuote ? `关键表达：${keyQuote}` : "本次暂未形成可总结的核心表达。"}`,
    keyQuote,
    saidTrack: saidTrack.length ? saidTrack : [keyQuote].filter(Boolean),
    learnedTrack: [
      "（本次为轻量记录：AI 综合暂不可用，仅保留你的原话，未做深度提炼或资产抽取。）"
    ],
    nextQuestions: [],
    createdAt: completedAt
  };

  // Deliberate design: when AI synthesis is unavailable we DO NOT fabricate or keyword-stuff
  // assets/themes (the project rejected auto-seeded "硬塞" themes — see engine.test.ts
  // "offline finalize produces an honest light record"). The honest light note is the
  // contract; full assets require the LLM path. Empty arrays here are correct, not a gap.
  return { note, points: [], questions: [], decisions: [], debts: [], themes: [] };
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
  completedAt: string,
  providedCandidates?: MemoryCandidate[]
): FinalizeResult {
  const { note } = content;
  const baseCompletedSession: InterviewSession = {
    ...session,
    status: "completed",
    completedAt,
    qualityReport: buildInterviewQualityReport(session)
  };

  if (session.doNotSave) {
    // doNotSave：按用户要求不写入长期资产 —— 不把这次会话塞进 sessions[]（否则会留下
    // 永久空壳、污染 timeline 并放大整-state 写），也不落 note/资产/记忆候选；只发结束审计事件。
    const nextState = withInterviewFinalizedEvents(
      cloneState(state),
      baseCompletedSession,
      note,
      completedAt
    );

    return { note, nextState };
  }

  // themeIds were resolved by finalize-llm into content.themes (existing id by name, or a
  // fresh id). Attach them to the session AND note so the "by theme" axis — Track 工作区 /
  // timeline / 会后反馈续问 — can actually aggregate this session's output. Deterministic
  // path has no themes → empty → no-op (no dangling refs).
  const themeIds = content.themes.map((theme) => theme.id).filter((id): id is string => Boolean(id));
  const completedSession: InterviewSession = themeIds.length
    ? { ...baseCompletedSession, relatedThemeIds: Array.from(new Set([...(session.relatedThemeIds ?? []), ...themeIds])) }
    : baseCompletedSession;
  const finalNote = themeIds.length ? { ...note, relatedThemeIds: themeIds } : note;

  const nextState = cloneState(state);
  nextState.sessions = [completedSession, ...nextState.sessions];
  nextState.searchBriefs = markSearchBriefAppliedToSession(nextState.searchBriefs, completedSession);
  nextState.notes = [finalNote, ...nextState.notes];
  if (providedCandidates && providedCandidates.length > 0) {
    // Use externally provided candidates (e.g. from LLM extraction in Task 2+).
    const annotated = annotateCandidatesWithDedupHint(providedCandidates, nextState.memoryRecords);
    nextState.memoryCandidates = [...annotated, ...(nextState.memoryCandidates ?? [])];
  } else if (note.keyQuote.trim()) {
    // Derive candidate from actual session content (deterministic fallback).
    const memoryCandidate = buildMemoryCandidateFromSession(session, finalNote, note.keyQuote, completedAt);
    const [annotated] = annotateCandidatesWithDedupHint([memoryCandidate], nextState.memoryRecords);
    nextState.memoryCandidates = [annotated, ...(nextState.memoryCandidates ?? [])];
  }
  nextState.points = [...content.points.map(p => ({ ...p, sourceSessionId: session.id })), ...nextState.points];
  nextState.questions = [...content.questions.map(q => ({ ...q, sourceSessionId: session.id })), ...nextState.questions];
  nextState.decisions = [...content.decisions.map(d => ({ ...d, sourceSessionId: session.id })), ...nextState.decisions];
  nextState.debts = [...content.debts.map(db => ({ ...db, sourceSessionId: session.id })), ...nextState.debts];
  nextState.themes = upsertFinalizeThemes(nextState.themes, content.themes, completedAt);

  return {
    note: finalNote,
    nextState: withInterviewFinalizedEvents(nextState, completedSession, finalNote, completedAt)
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
    // ponytail: trim-normalize the name match so "控制感" and "控制感 " don't split into
    // two themes (which would dilute appearances and fragment the theme line).
    const key = upsert.name.trim();
    if (themes.some((theme) => theme.name.trim() === key)) {
      themes = themes.map((theme) =>
        theme.name.trim() === key
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
          // ponytail: stamp createdAt at birth so the timeline shows the theme's萌芽
          // moment, not whatever the last upsert refreshed updatedAt to.
          createdAt: completedAt,
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
      .sort((a, b) => scoreQuote(b) - scoreQuote(a))[0] ?? ""
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
