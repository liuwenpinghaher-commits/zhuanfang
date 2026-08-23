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
import { checkAxioms } from "./axioms";
import {
  annotateCandidateConflict,
  collectConflictCorrectionTexts,
  withMemoryCandidateReview
} from "./memoryReview";
import { addProfileSuggestions, type ProfileSuggestionInput } from "./profile";
import { buildInterviewQualityReport, planMemoryUpdate, tokenizeMemoryGraphText } from "./engine";
import { uniqueStrings } from "./signals";
import { resolveEvidenceAnchors, stampFinalizeAnchors } from "./raw-material";

/**
 * M2 (Task 6): tag each fresh candidate with an extract-then-update dedup hint
 * against already-confirmed memories, so the HITL reviewer sees "似已有记忆 X".
 * Pure: candidates carry no embedding at finalize time, so planMemoryUpdate uses
 * its token-overlap fallback. Never mutates the store — only annotates candidates.
 * Realization Must-set: also surface conflicts vs memoryCorrections + note learnedTrack.
 */
function annotateCandidatesWithDedupHint(
  candidates: MemoryCandidate[],
  records: ProductState["memoryRecords"],
  corrections: string[] = []
): MemoryCandidate[] {
  return candidates.map((candidate) => {
    let next: MemoryCandidate = candidate;
    if (records && records.length > 0) {
      const plan = planMemoryUpdate({ text: candidate.text }, records);
      if (plan.op === "update" && plan.similarToRecordId) {
        next = { ...candidate, suggestedUpdate: "update", similarToRecordId: plan.similarToRecordId };
      } else {
        next = { ...candidate, suggestedUpdate: "add" };
      }
    }
    return annotateCandidateConflict(next, corrections);
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
  /** P0b: finalize-time proposals that currentFocus / longTermGoal has shifted (HITL). */
  profileSuggestions?: ProfileSuggestionInput[];
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
  const { endCheckpoint: _endCheckpoint, ...sessionWithoutCheckpoint } = session;
  const baseCompletedSession: InterviewSession = {
    ...sessionWithoutCheckpoint,
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
    // Use externally provided candidates (from LLM extraction over the real conversation).
    const corrections = collectConflictCorrectionTexts({
      memoryCorrections: nextState.memoryCorrections,
      learnedTrack: finalNote.learnedTrack
    });
    const annotated = annotateCandidatesWithDedupHint(
      providedCandidates,
      nextState.memoryRecords,
      corrections
    );
    const anchored = stampFinalizeAnchors(annotated, session.id, session.turns);
    nextState.memoryCandidates = [...anchored, ...(nextState.memoryCandidates ?? [])];
  }
  // providedCandidates 为空数组 = LLM 明确判定本次对话没有值得沉淀的长期记忆——诚实的空。
  // （旧的"从 keyQuote 启发式造一条模板候选"回退已剔除：不能用就暴露，不伪造记忆候选。）
  nextState.points = upsertFinalizePoints(nextState.points, content.points, session.id, completedAt);
  nextState.questions = upsertFinalizeQuestions(nextState.questions, content.questions, session.id, completedAt);
  nextState.decisions = upsertFinalizeDecisions(nextState.decisions, content.decisions, session.id, completedAt);
  nextState.debts = upsertFinalizeDebts(nextState.debts, content.debts, session.id, completedAt);
  nextState.themes = upsertFinalizeThemes(nextState.themes, content.themes, completedAt);

  // ── 证据锚点扩展：把 LLM 逐字摘录回匹配到来自的 user 轮。匹配不到不盖、不伪造来源。──
  const anchor = (quote: string | undefined) => resolveEvidenceAnchors(quote ?? "", session.id, session.turns)[0];

  // points/decisions/debts(都是 Distillation,A1 要求溯源):本次 session 产生且尚未盖锚点的,
  // 用首个非空证据原话解析回 user turn。匹配不到不盖、不伪造来源(诚实留空,A1 会如实报缺)。
  // F:decisions/debts 此前从不盖锚 → checkA1 每次违例;现与 points 对称(LLM 也为它们输出 evidence)。
  const stampDistillationAnchor = <T extends {
    sourceSessionId?: string;
    appearedInSessionIds?: string[];
    evidence?: string[];
    evidenceAnchors?: ReturnType<typeof resolveEvidenceAnchors>;
  }>(asset: T): T => {
    const appearedHere =
      asset.sourceSessionId === session.id || (asset.appearedInSessionIds ?? []).includes(session.id);
    if (!appearedHere) {
      return asset;
    }
    if (asset.evidenceAnchors?.some((item) => item.sessionId === session.id)) {
      return asset;
    }
    const evidenceQuote = asset.evidence?.find((e) => e.trim());
    const anchors = resolveEvidenceAnchors(evidenceQuote ?? "", session.id, session.turns);
    return anchors.length > 0
      ? { ...asset, evidenceAnchors: [...(asset.evidenceAnchors ?? []), ...anchors] }
      : asset;
  };
  nextState.points = nextState.points.map(stampDistillationAnchor);
  nextState.decisions = nextState.decisions.map(stampDistillationAnchor);
  nextState.debts = nextState.debts.map(stampDistillationAnchor);

  // note.keyQuoteAnchor: 单 anchor。已有则不动。
  const keyQuoteAnchor = finalNote.keyQuoteAnchor ?? anchor(finalNote.keyQuote);
  const anchoredNote: DualTrackNote = keyQuoteAnchor ? { ...finalNote, keyQuoteAnchor } : finalNote;
  if (anchoredNote !== finalNote) {
    nextState.notes = nextState.notes.map((n) => (n.id === finalNote.id ? anchoredNote : n));
  }

  // themes: 对本次 content.themes 涉及的主题线（按归一化名匹配定位），用 representativeQuote 解析。
  const upsertNameKeys = new Set(content.themes.map((t) => normalizeThemeName(t.name)));
  if (upsertNameKeys.size > 0) {
    nextState.themes = nextState.themes.map((theme) => {
      if (!upsertNameKeys.has(normalizeThemeName(theme.name)) || theme.representativeQuoteAnchor) {
        return theme;
      }
      const representativeQuoteAnchor = anchor(theme.representativeQuote);
      return representativeQuoteAnchor ? { ...theme, representativeQuoteAnchor } : theme;
    });
  }

  // P0b: queue any proposed currentFocus/longTermGoal shift for HITL approval (no-ops dropped).
  const withSuggestions = content.profileSuggestions?.length
    ? addProfileSuggestions(nextState, content.profileSuggestions, session.id, completedAt)
    : nextState;

  const finalized = withInterviewFinalizedEvents(withSuggestions, completedSession, anchoredNote, completedAt);

  // P3 公理引擎(统一兜底/审计层):写完本次 finalize 后跑一遍 checkAxioms,违例只记审计、**不阻断写**
  // (对齐现有 withAuditEvent 模式 + spec 03 §3"记 auditEvent");既有散落规则继续工作,这里再核一遍。
  return {
    note: anchoredNote,
    nextState: withAxiomAuditEvents(finalized, completedSession.id, completedAt)
  };
}

/**
 * P3:在写路径尾部跑统一公理校验器,把违例落成可审计的 auditEvent(每次 finalize 至多一条汇总事件,
 * 避免逐实体刷屏)。**纯审计、不拦截**——封闭世界下只报已存在事实的违例。无违例则原样返回。
 */
export function withAxiomAuditEvents(state: ProductState, sessionId: string, createdAt: string): ProductState {
  const violations = checkAxioms(state);
  if (violations.length === 0) {
    return state;
  }
  const counts = violations.reduce<Record<string, number>>((acc, v) => {
    acc[v.axiom] = (acc[v.axiom] ?? 0) + 1;
    return acc;
  }, {});
  const summary = Object.entries(counts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([axiom, n]) => `${axiom}×${n}`)
    .join("、");
  return withAuditEvent(state, {
    type: "axiom_violation",
    label: "公理校验发现违例",
    detail: `本次沉淀后统一公理校验命中 ${violations.length} 处违例(${summary})。详见公理引擎(A1 溯源／A2 成熟度／A3 HITL／A4 敏感)。`,
    severity: "warning",
    entityType: "interview_session",
    entityId: sessionId,
    createdAt
  });
}

const MATURITY_LADDER: LongTermTheme["maturity"][] = ["萌芽", "重复", "聚焦", "成型", "变化", "关闭"];

/**
 * Maturity must reflect REAL recurrence, not a one-shot LLM impression. A theme can be at most
 * as mature as its appearance count allows (1 appearance → 萌芽, 2 → 重复, 3 → 聚焦, 4 → 成型,
 * 5 → 变化, 6+ → 关闭). The LLM's per-conversation label is clamped DOWN to this ceiling (never
 * up) — fixing the "出现 1 次却标成型/聚焦" incoherence where maturity was decoupled from tracking.
 */
export function clampMaturityByAppearances(
  maturity: LongTermTheme["maturity"] | string,
  appearances: number
): LongTermTheme["maturity"] {
  const idx = Math.max(0, MATURITY_LADDER.indexOf(maturity as LongTermTheme["maturity"]));
  const ceiling = Math.min(MATURITY_LADDER.length - 1, Math.max(0, appearances - 1));
  return MATURITY_LADDER[Math.min(idx, ceiling)];
}

/** Normalize a theme name for matching so trivial variants ("控制感" / "控制感。" / "控制感 ")
 *  merge into one theme line instead of fragmenting into several. */
function normalizeThemeName(name: string): string {
  return name.trim().replace(/[\s。，、；：！？·.,;:!?]/g, "");
}

function mergeRelatedThemeIds(existing: string[] | undefined, incoming: string[] | undefined): string[] {
  return Array.from(new Set([...(existing ?? []), ...(incoming ?? [])]));
}

function mergeAppearedInSessionIds(
  existing: string[] | undefined,
  origin: string | undefined,
  sessionId: string
): string[] {
  return Array.from(new Set([...(existing ?? []), ...(origin ? [origin] : []), sessionId].filter(Boolean)));
}

function mergeEvidence(existing: string[] | undefined, incoming: string[] | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of [...(existing ?? []), ...(incoming ?? [])]) {
    const trimmed = item.trim();
    if (!trimmed) continue;
    const key = normalizeThemeName(trimmed);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

/** Upsert each theme: merge into an existing theme line by normalized name (increment
 *  appearances, refresh quote/next-question, clamp maturity to the new count), else create a
 *  fresh theme born at 萌芽. */
/** 审查改进(M3):按归一化 concept upsert 知识债——命中同概念则 appearances++ 并 refresh,否则新建 appearances=1。
 *  与 upsertFinalizeThemes 对称,根治"同概念债每次 finalize 重复 prepend"+ 补"反复欠的债"优先级信号。 */
/** 审计修复(P2-11):question 此前是纯 prepend——同题跨场堆积、appearances 恒 1 却被 UI 当
 *  「出现次数」展示、「反复出现」状态机器不可达。与 debts/themes 对称:按问题文本归一 upsert,
 *  命中则 appearances+1 并将仍处「开放」的问题升为「反复出现」(该状态首次获得机器写入路径);
 *  用户已置的「正在聚焦/阶段性回答」不被覆盖(与 debt 守卫同公理)。 */
export function upsertFinalizePoints(
  existingPoints: PointAsset[],
  incoming: PointAsset[],
  sessionId: string,
  completedAt: string
): PointAsset[] {
  let points = existingPoints;
  for (const inc of incoming) {
    const key = normalizeThemeName(inc.title) || normalizeThemeName(inc.content);
    const match = key
      ? points.find((p) => (normalizeThemeName(p.title) || normalizeThemeName(p.content)) === key)
      : undefined;
    if (match) {
      const userLocked = match.confidence === "用户确认" || match.status === "已放弃" || match.status === "已修正";
      points = points.map((p) =>
        p.id === match.id
          ? {
              ...p,
              content: inc.content || p.content,
              evidence: mergeEvidence(p.evidence, inc.evidence),
              relatedThemeIds: mergeRelatedThemeIds(p.relatedThemeIds, inc.relatedThemeIds),
              appearedInSessionIds: mergeAppearedInSessionIds(p.appearedInSessionIds, p.sourceSessionId, sessionId),
              status: userLocked ? p.status : inc.status || p.status,
              confidence: userLocked ? p.confidence : inc.confidence || p.confidence,
              updatedAt: completedAt
            }
          : p
      );
    } else {
      points = [{
        ...inc,
        sourceSessionId: sessionId,
        appearedInSessionIds: [sessionId]
      }, ...points];
    }
  }
  return points;
}

export function upsertFinalizeDecisions(
  existingDecisions: DecisionAsset[],
  incoming: DecisionAsset[],
  sessionId: string,
  completedAt: string
): DecisionAsset[] {
  let decisions = existingDecisions;
  for (const inc of incoming) {
    const key = normalizeThemeName(inc.title) || normalizeThemeName(inc.choice);
    const match = key
      ? decisions.find((d) => (normalizeThemeName(d.title) || normalizeThemeName(d.choice)) === key)
      : undefined;
    if (match) {
      const userLocked = match.confirmationStatus === "用户确认" || match.status === "已复盘";
      decisions = decisions.map((d) =>
        d.id === match.id
          ? {
              ...d,
              choice: inc.choice || d.choice,
              tradeOff: inc.tradeOff || d.tradeOff,
              riskHypothesis: inc.riskHypothesis || d.riskHypothesis,
              evidence: mergeEvidence(d.evidence, inc.evidence),
              relatedThemeIds: mergeRelatedThemeIds(d.relatedThemeIds, inc.relatedThemeIds),
              appearedInSessionIds: mergeAppearedInSessionIds(d.appearedInSessionIds, d.sourceSessionId, sessionId),
              confirmationStatus: userLocked ? d.confirmationStatus : inc.confirmationStatus || d.confirmationStatus,
              status: userLocked ? d.status : inc.status || d.status,
              updatedAt: completedAt
            }
          : d
      );
    } else {
      decisions = [{
        ...inc,
        sourceSessionId: sessionId,
        appearedInSessionIds: [sessionId]
      }, ...decisions];
    }
  }
  return decisions;
}

export function upsertFinalizeQuestions(
  existingQuestions: QuestionAsset[],
  incoming: QuestionAsset[],
  sessionId: string,
  completedAt: string
): QuestionAsset[] {
  let questions = existingQuestions;
  for (const inc of incoming) {
    const key = normalizeThemeName(inc.question);
    const match = key ? questions.find((q) => normalizeThemeName(q.question) === key) : undefined;
    if (match) {
      questions = questions.map((q) =>
        q.id === match.id
          ? {
              ...q,
              appearances: (q.appearances ?? 1) + 1,
              whyImportant: inc.whyImportant || q.whyImportant,
              nextPrompt: inc.nextPrompt || q.nextPrompt,
              // 回归审查 R5-4:合并去重(旧∪新)而非替换——一个问题可跨多主题,替换会丢历史主题链
              // (首次[控制感]、再现命中[风险偏好]→原替换只剩[风险偏好])。与 debt upsert"保留既有"语义对齐。
              relatedThemeIds: mergeRelatedThemeIds(q.relatedThemeIds, inc.relatedThemeIds),
              appearedInSessionIds: mergeAppearedInSessionIds(q.appearedInSessionIds, q.sourceSessionId, sessionId),
              status: q.status === "开放" ? "反复出现" : q.status,
              updatedAt: completedAt
            }
          : q
      );
    } else {
      questions = [{
        ...inc,
        sourceSessionId: sessionId,
        appearedInSessionIds: [sessionId],
        appearances: inc.appearances ?? 1
      }, ...questions];
    }
  }
  return questions;
}

export function upsertFinalizeDebts(
  existingDebts: KnowledgeDebt[],
  incoming: KnowledgeDebt[],
  sessionId: string,
  completedAt: string
): KnowledgeDebt[] {
  let debts = existingDebts;
  for (const inc of incoming) {
    const key = normalizeThemeName(inc.concept);
    const match = key ? debts.find((d) => normalizeThemeName(d.concept) === key) : undefined;
    if (match) {
      // 审计修复(P2-9):status 是知识债唯一的"用户确认"载体(无 confidence 字段)。用户显式置的
      // 「不相关/已应用/能复述」不被 LLM 重提同概念时静默重置回「待了解」——那会让已判定不相关的
      // 概念重回追问队列,违背"用户确认不被 AI 覆盖"公理(与 point C 守卫/decision 409 对称)。
      // 仅当既有状态仍是初始「待了解」时才接受 incoming status;其余保留用户状态,计数照常自增。
      debts = debts.map((d) =>
        d.id === match.id
          ? {
              ...d,
              appearances: (d.appearances ?? 1) + 1,
              context: inc.context,
              whyImportant: inc.whyImportant,
              nextQuestion: inc.nextQuestion,
              relatedThemeIds: mergeRelatedThemeIds(d.relatedThemeIds, inc.relatedThemeIds),
              appearedInSessionIds: mergeAppearedInSessionIds(d.appearedInSessionIds, d.sourceSessionId, sessionId),
              evidence: mergeEvidence(d.evidence, inc.evidence),
              status: d.status === "待了解" ? inc.status : d.status,
              updatedAt: completedAt
            }
          : d
      );
    } else {
      debts = [{
        ...inc,
        sourceSessionId: sessionId,
        appearedInSessionIds: [sessionId],
        appearances: inc.appearances ?? 1
      }, ...debts];
    }
  }
  return debts;
}

export function upsertFinalizeThemes(
  existingThemes: LongTermTheme[],
  upserts: FinalizeThemeUpsert[],
  completedAt: string
): LongTermTheme[] {
  let themes = existingThemes;
  for (const upsert of upserts) {
    const key = normalizeThemeName(upsert.name);
    const match = themes.find((theme) => normalizeThemeName(theme.name) === key);
    if (match) {
      const appearances = match.appearances + 1;
      themes = themes.map((theme) =>
        theme.id === match.id
          ? {
              ...theme,
              maturity: clampMaturityByAppearances(upsert.maturity, appearances),
              appearances,
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
          // A brand-new theme has appeared exactly once — it is 萌芽, no matter how developed it
          // felt in this single conversation.
          maturity: clampMaturityByAppearances(upsert.maturity, 1),
          representativeQuote: upsert.representativeQuote,
          appearances: 1,
          nextQuestion: upsert.nextQuestion,
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
