import type {
  CorpusInsight,
  DualTrackNote,
  MemoryCandidate,
  MemoryRecord,
  PodcastEpisode,
  ProductState,
  SearchBrief
} from "./types";
import { nowIso, withAuditEvent } from "./utils";

export const DELETE_SESSION_NOTE_CONFIRM = "DELETE_SESSION_NOTE";

export interface ForgetSessionNoteOptions {
  /** 勾选后才删「只属于这场」的观点/问题/决策/债；跨场条目只摘这场痕迹。 */
  exclusiveAssets?: boolean;
  /** 勾选后才删证据只来自这场的已确认记忆。默认不删。 */
  confirmedMemory?: boolean;
}

export interface ForgetSessionNoteCounts {
  points: number;
  questions: number;
  decisions: number;
  debts: number;
  confirmedMemories: number;
}

export interface ForgetSessionNoteReceipt {
  noteId: string;
  sessionId: string;
  noteTitle: string;
  removed: {
    note: true;
    session: boolean;
    pendingMemories: number;
    podcasts: number;
    annotations: number;
    exclusivePoints: number;
    exclusiveQuestions: number;
    exclusiveDecisions: number;
    exclusiveDebts: number;
    confirmedMemories: number;
  };
  keptShared: ForgetSessionNoteCounts;
  removedIds: {
    points: string[];
    questions: string[];
    decisions: string[];
    debts: string[];
    memories: string[];
    podcasts: string[];
  };
  summary: string;
}

export interface ForgetSessionNoteResult {
  nextState: ProductState;
  receipt: ForgetSessionNoteReceipt;
}

type SessionScoped = {
  id: string;
  sourceSessionId?: string;
  appearedInSessionIds?: string[];
  evidenceAnchors?: Array<{ sessionId: string }>;
};

function otherSessionIds(asset: SessionScoped, sessionId: string): Set<string> {
  const ids = new Set<string>();
  if (asset.sourceSessionId && asset.sourceSessionId !== sessionId) {
    ids.add(asset.sourceSessionId);
  }
  for (const id of asset.appearedInSessionIds ?? []) {
    if (id && id !== sessionId) ids.add(id);
  }
  for (const anchor of asset.evidenceAnchors ?? []) {
    if (anchor.sessionId && anchor.sessionId !== sessionId) ids.add(anchor.sessionId);
  }
  return ids;
}

function appearedInSession(asset: SessionScoped, sessionId: string): boolean {
  if (asset.sourceSessionId === sessionId) return true;
  if (asset.appearedInSessionIds?.includes(sessionId)) return true;
  if (asset.evidenceAnchors?.some((anchor) => anchor.sessionId === sessionId)) return true;
  return false;
}

/** 来源是这场，且档案/锚点里没有别的场。 */
function isExclusiveToSession(asset: SessionScoped, sessionId: string): boolean {
  if (asset.sourceSessionId !== sessionId) return false;
  return otherSessionIds(asset, sessionId).size === 0;
}

function stripSessionTrace<T extends SessionScoped>(asset: T, sessionId: string): T {
  const next: T = { ...asset };
  if (asset.appearedInSessionIds) {
    next.appearedInSessionIds = asset.appearedInSessionIds.filter((id) => id !== sessionId);
  }
  if (asset.evidenceAnchors) {
    next.evidenceAnchors = asset.evidenceAnchors.filter((anchor) => anchor.sessionId !== sessionId);
  }
  return next;
}

function podcastFromNote(episode: PodcastEpisode, noteId: string): boolean {
  if (episode.sourceType && episode.sourceType !== "note") return false;
  if (episode.sourceType === "note" && episode.sourceId === noteId) return true;
  return episode.noteId === noteId;
}

function candidateFromSession(candidate: MemoryCandidate, sessionId: string, noteId: string): boolean {
  if (candidate.sourceType === "interview_session" && candidate.sourceId === sessionId) return true;
  if (candidate.sourceType === "dual_track_note" && candidate.sourceId === noteId) return true;
  return false;
}

function confirmedMemoryOnlyFromSession(record: MemoryRecord, sessionId: string, noteId: string): boolean {
  if (record.status !== "confirmed") return false;
  const anchors = record.evidenceAnchors ?? [];
  if (anchors.length > 0) {
    return anchors.every((anchor) => anchor.sessionId === sessionId);
  }
  if (record.sourceType === "interview_session" && record.sourceId === sessionId) return true;
  if (record.sourceType === "dual_track_note" && record.sourceId === noteId) return true;
  return false;
}

function confirmedMemoryTouchesSession(record: MemoryRecord, sessionId: string, noteId: string): boolean {
  if (record.sourceType === "interview_session" && record.sourceId === sessionId) return true;
  if (record.sourceType === "dual_track_note" && record.sourceId === noteId) return true;
  if (record.evidenceAnchors?.some((anchor) => anchor.sessionId === sessionId)) return true;
  return false;
}

function countPhrase(n: number, unit: string): string {
  return `${n} 条${unit}`;
}

function buildForgetSummary(input: {
  removedSession: boolean;
  exclusive: ForgetSessionNoteCounts;
  shared: ForgetSessionNoteCounts;
  podcasts: number;
  pendingMemories: number;
  deletedExclusiveAssets: boolean;
  deletedConfirmedMemory: boolean;
}): string {
  const lead = input.removedSession ? "已拿走这篇笔记和这场专访记录" : "已拿走这篇笔记";
  const extra: string[] = [];
  if (input.deletedExclusiveAssets) {
    const bits: string[] = [];
    if (input.exclusive.points) bits.push(countPhrase(input.exclusive.points, "只属于这场的观点"));
    if (input.exclusive.questions) bits.push(countPhrase(input.exclusive.questions, "只属于这场的问题"));
    if (input.exclusive.decisions) bits.push(countPhrase(input.exclusive.decisions, "只属于这场的决策"));
    if (input.exclusive.debts) bits.push(countPhrase(input.exclusive.debts, "只属于这场的债"));
    if (bits.length) extra.push(`同时拿走了${bits.join("、")}`);
  }
  if (input.deletedConfirmedMemory && input.exclusive.confirmedMemories) {
    extra.push(`拿走了${countPhrase(input.exclusive.confirmedMemories, "只来自这场的已点头记忆")}`);
  }
  const kept: string[] = [];
  if (input.shared.points) kept.push(countPhrase(input.shared.points, "还在别的场用的观点"));
  if (input.shared.questions) kept.push(countPhrase(input.shared.questions, "还在别的场用的问题"));
  if (input.shared.decisions) kept.push(countPhrase(input.shared.decisions, "还在别的场用的决策"));
  if (input.shared.debts) kept.push(countPhrase(input.shared.debts, "还在别的场用的债"));
  if (input.shared.confirmedMemories) kept.push(countPhrase(input.shared.confirmedMemories, "别的场也用过的记忆"));
  if (!input.deletedExclusiveAssets) {
    const left: string[] = [];
    if (input.exclusive.points) left.push(countPhrase(input.exclusive.points, "只属于这场的观点"));
    if (input.exclusive.questions) left.push(countPhrase(input.exclusive.questions, "只属于这场的问题"));
    if (input.exclusive.decisions) left.push(countPhrase(input.exclusive.decisions, "只属于这场的决策"));
    if (input.exclusive.debts) left.push(countPhrase(input.exclusive.debts, "只属于这场的债"));
    if (left.length) kept.push(...left);
  }
  if (!input.deletedConfirmedMemory && input.exclusive.confirmedMemories) {
    kept.push(countPhrase(input.exclusive.confirmedMemories, "已点头的记忆"));
  }
  const tail: string[] = [];
  if (input.pendingMemories) tail.push(`这场还没点头的 ${input.pendingMemories} 条待审记忆也拿走了`);
  if (input.podcasts) tail.push(`用这篇笔记做的 ${input.podcasts} 条播客也拿走了`);
  let text = `${lead}。`;
  if (extra.length) text += `${extra.join("。")}。`;
  if (kept.length) text += `留下了${kept.join("、")}。`;
  if (tail.length) text += `${tail.join("。")}。`;
  return text;
}

function partitionAssets<T extends SessionScoped>(items: T[], sessionId: string): { exclusive: T[]; shared: T[] } {
  const exclusive: T[] = [];
  const shared: T[] = [];
  for (const item of items) {
    if (!appearedInSession(item, sessionId)) continue;
    if (isExclusiveToSession(item, sessionId)) exclusive.push(item);
    else shared.push(item);
  }
  return { exclusive, shared };
}

/**
 * 打开笔记，这一场能安全拿走什么、必须留下什么。
 * 笔记不存在时返回 null。不碰主题线、导入素材、语料补丁。
 */
export function forgetSessionNote(
  state: ProductState,
  noteId: string,
  options: ForgetSessionNoteOptions = {}
): ForgetSessionNoteResult | null {
  const note = state.notes.find((item) => item.id === noteId);
  if (!note) return null;

  const sessionId = note.sessionId;
  const deleteExclusive = Boolean(options.exclusiveAssets);
  const deleteConfirmed = Boolean(options.confirmedMemory);
  const remainingNotes = state.notes.filter((item) => item.id !== noteId);
  const sessionStillReferenced = remainingNotes.some((item) => item.sessionId === sessionId);
  const removeSession = !sessionStillReferenced;

  const points = partitionAssets(state.points, sessionId);
  const questions = partitionAssets(state.questions, sessionId);
  const decisions = partitionAssets(state.decisions, sessionId);
  const debts = partitionAssets(state.debts, sessionId);

  const pendingFromSession = state.memoryCandidates.filter((candidate) =>
    candidateFromSession(candidate, sessionId, noteId)
  );
  const exclusiveMemories = state.memoryRecords.filter((record) =>
    confirmedMemoryOnlyFromSession(record, sessionId, noteId)
  );
  const sharedMemories = state.memoryRecords.filter((record) => {
    if (exclusiveMemories.some((item) => item.id === record.id)) return false;
    return confirmedMemoryTouchesSession(record, sessionId, noteId) && otherSessionIds(record, sessionId).size > 0;
  });
  const podcasts = state.podcastEpisodes.filter((episode) => podcastFromNote(episode, noteId));
  const annotations = state.interviewAnnotations.filter((item) => item.sessionId === sessionId);

  const removedPointIds = new Set(deleteExclusive ? points.exclusive.map((item) => item.id) : []);
  const removedQuestionIds = new Set(deleteExclusive ? questions.exclusive.map((item) => item.id) : []);
  const removedDecisionIds = new Set(deleteExclusive ? decisions.exclusive.map((item) => item.id) : []);
  const removedDebtIds = new Set(deleteExclusive ? debts.exclusive.map((item) => item.id) : []);
  const removedMemoryIds = new Set(deleteConfirmed ? exclusiveMemories.map((item) => item.id) : []);
  const removedPodcastIds = podcasts.map((item) => item.id);
  const pendingIds = new Set(pendingFromSession.map((item) => item.id));

  const nextPoints = mapKeptAssets(state.points, sessionId, removedPointIds);
  const nextQuestions = mapKeptAssets(state.questions, sessionId, removedQuestionIds);
  const nextDecisions = mapKeptAssets(state.decisions, sessionId, removedDecisionIds);
  const nextDebts = mapKeptAssets(state.debts, sessionId, removedDebtIds);
  const nextMemories = state.memoryRecords
    .filter((record) => !removedMemoryIds.has(record.id))
    .map((record) =>
      confirmedMemoryTouchesSession(record, sessionId, noteId) ? stripSessionTrace(record, sessionId) : record
    );

  const exclusiveCounts: ForgetSessionNoteCounts = {
    points: points.exclusive.length,
    questions: questions.exclusive.length,
    decisions: decisions.exclusive.length,
    debts: debts.exclusive.length,
    confirmedMemories: exclusiveMemories.length
  };
  const sharedCounts: ForgetSessionNoteCounts = {
    points: points.shared.length,
    questions: questions.shared.length,
    decisions: decisions.shared.length,
    debts: debts.shared.length,
    confirmedMemories: sharedMemories.length
  };

  const receipt: ForgetSessionNoteReceipt = {
    noteId: note.id,
    sessionId,
    noteTitle: note.title,
    removed: {
      note: true,
      session: removeSession,
      pendingMemories: pendingFromSession.length,
      podcasts: podcasts.length,
      annotations: annotations.length,
      exclusivePoints: deleteExclusive ? points.exclusive.length : 0,
      exclusiveQuestions: deleteExclusive ? questions.exclusive.length : 0,
      exclusiveDecisions: deleteExclusive ? decisions.exclusive.length : 0,
      exclusiveDebts: deleteExclusive ? debts.exclusive.length : 0,
      confirmedMemories: deleteConfirmed ? exclusiveMemories.length : 0
    },
    keptShared: {
      points: points.shared.length + (deleteExclusive ? 0 : points.exclusive.length),
      questions: questions.shared.length + (deleteExclusive ? 0 : questions.exclusive.length),
      decisions: decisions.shared.length + (deleteExclusive ? 0 : decisions.exclusive.length),
      debts: debts.shared.length + (deleteExclusive ? 0 : debts.exclusive.length),
      confirmedMemories: sharedMemories.length + (deleteConfirmed ? 0 : exclusiveMemories.length)
    },
    removedIds: {
      points: [...removedPointIds],
      questions: [...removedQuestionIds],
      decisions: [...removedDecisionIds],
      debts: [...removedDebtIds],
      memories: [...removedMemoryIds],
      podcasts: removedPodcastIds
    },
    summary: buildForgetSummary({
      removedSession: removeSession,
      exclusive: exclusiveCounts,
      shared: sharedCounts,
      podcasts: podcasts.length,
      pendingMemories: pendingFromSession.length,
      deletedExclusiveAssets: deleteExclusive,
      deletedConfirmedMemory: deleteConfirmed
    })
  };

  const nextState = withAuditEvent(
    {
      ...state,
      notes: remainingNotes,
      sessions: removeSession ? state.sessions.filter((item) => item.id !== sessionId) : state.sessions,
      points: nextPoints,
      questions: nextQuestions,
      decisions: nextDecisions,
      debts: nextDebts,
      memoryRecords: nextMemories,
      memoryCandidates: state.memoryCandidates.filter((candidate) => !pendingIds.has(candidate.id)),
      podcastEpisodes: state.podcastEpisodes.filter((episode) => !removedPodcastIds.includes(episode.id)),
      interviewAnnotations: removeSession
        ? state.interviewAnnotations.filter((item) => item.sessionId !== sessionId)
        : state.interviewAnnotations
      // sessionStillReferenced 时留下旁注，因为另一篇笔记还挂着这场
    },
    {
      type: "session_note_forgotten",
      label: "已删除一场专访笔记",
      detail: receipt.summary,
      severity: "warning",
      entityType: "dual_track_note",
      entityId: note.id,
      createdAt: nowIso()
    }
  );

  return { nextState, receipt };
}

function mapKeptAssets<T extends SessionScoped>(items: T[], sessionId: string, removedIds: Set<string>): T[] {
  return items
    .filter((item) => !removedIds.has(item.id))
    .map((item) => (appearedInSession(item, sessionId) ? stripSessionTrace(item, sessionId) : item));
}

/** 确认框用：这场抽出物里，哪些只属于这场、哪些已经并进别的场。 */
export function describeForgetImpact(
  state: ProductState,
  noteId: string
): {
  note: DualTrackNote;
  exclusive: ForgetSessionNoteCounts;
  shared: ForgetSessionNoteCounts;
  pendingMemories: number;
  podcasts: number;
  annotations: number;
} | null {
  const note = state.notes.find((item) => item.id === noteId);
  if (!note) return null;
  const sessionId = note.sessionId;
  const points = partitionAssets(state.points, sessionId);
  const questions = partitionAssets(state.questions, sessionId);
  const decisions = partitionAssets(state.decisions, sessionId);
  const debts = partitionAssets(state.debts, sessionId);
  const exclusiveMemories = state.memoryRecords.filter((record) =>
    confirmedMemoryOnlyFromSession(record, sessionId, noteId)
  );
  const sharedMemories = state.memoryRecords.filter((record) => {
    if (exclusiveMemories.some((item) => item.id === record.id)) return false;
    return confirmedMemoryTouchesSession(record, sessionId, noteId) && otherSessionIds(record, sessionId).size > 0;
  });
  return {
    note,
    exclusive: {
      points: points.exclusive.length,
      questions: questions.exclusive.length,
      decisions: decisions.exclusive.length,
      debts: debts.exclusive.length,
      confirmedMemories: exclusiveMemories.length
    },
    shared: {
      points: points.shared.length,
      questions: questions.shared.length,
      decisions: decisions.shared.length,
      debts: debts.shared.length,
      confirmedMemories: sharedMemories.length
    },
    pendingMemories: state.memoryCandidates.filter((candidate) =>
      candidateFromSession(candidate, sessionId, noteId)
    ).length,
    podcasts: state.podcastEpisodes.filter((episode) => podcastFromNote(episode, noteId)).length,
    annotations: state.interviewAnnotations.filter((item) => item.sessionId === sessionId).length
  };
}


export interface GeneratedArtifactRemovalCounts {
  searchBriefs: number;
  podcastEpisodes: number;
  corpusInsights: number;
}

export interface GeneratedArtifactCleanupResult {
  nextState: ProductState;
  removed: GeneratedArtifactRemovalCounts;
}

export function deleteSearchBrief(state: ProductState, briefId: string): ProductState {
  return {
    ...state,
    searchBriefs: state.searchBriefs.filter((brief) => brief.id !== briefId)
  };
}

export function deletePodcastEpisode(state: ProductState, episodeId: string): ProductState {
  return {
    ...state,
    podcastEpisodes: state.podcastEpisodes.filter((episode) => episode.id !== episodeId)
  };
}

/**
 * Remove an active interview shell that never received a user turn.
 * Returns null when the session is missing, completed, or already has user content.
 */
export function discardEmptyActiveInterviewSession(state: ProductState, sessionId: string): ProductState | null {
  const session = state.sessions.find((item) => item.id === sessionId);
  if (!session || session.status !== "active") {
    return null;
  }
  const userTurns = session.turns.filter((turn) => turn.role === "user");
  if (userTurns.length > 0) {
    return null;
  }
  return {
    ...state,
    sessions: state.sessions.filter((item) => item.id !== sessionId)
  };
}

export function deleteCorpusInsightBundle(state: ProductState, insightId: string): ProductState {
  const insight = state.corpusInsights.find((item) => item.id === insightId);
  if (!insight) {
    return state;
  }

  return {
    ...state,
    corpusImports: state.corpusImports.filter((item) => item.id !== insight.importId),
    corpusInsights: state.corpusInsights.filter((item) => item.id !== insightId),
    playbookPatches: state.playbookPatches.filter(
      (patch) => patch.sourceInsightId !== insightId || patch.status === "applied"
    )
  };
}

export function dedupeGeneratedArtifacts(state: ProductState): GeneratedArtifactCleanupResult {
  const search = keepFirstBy(state.searchBriefs, searchBriefKey);
  const podcasts = keepFirstBy(state.podcastEpisodes, podcastEpisodeKey);
  const corpus = keepFirstBy(state.corpusInsights, corpusInsightKey);
  const removedInsightIds = new Set(corpus.removedItems.map((insight) => insight.id));
  const removedImportIds = new Set(corpus.removedItems.map((insight) => insight.importId));

  return {
    nextState: {
      ...state,
      searchBriefs: search.items,
      podcastEpisodes: podcasts.items,
      corpusImports: state.corpusImports.filter((item) => !removedImportIds.has(item.id)),
      corpusInsights: corpus.items,
      playbookPatches: state.playbookPatches.filter(
        (patch) => !removedInsightIds.has(patch.sourceInsightId) || patch.status === "applied"
      )
    },
    removed: {
      searchBriefs: search.removed,
      podcastEpisodes: podcasts.removed,
      corpusInsights: corpus.removed
    }
  };
}

function keepFirstBy<T>(items: T[], getKey: (item: T) => string): { items: T[]; removed: number; removedItems: T[] } {
  const seen = new Set<string>();
  const kept: T[] = [];
  const removedItems: T[] = [];

  for (const item of items) {
    const key = getKey(item);
    if (seen.has(key)) {
      removedItems.push(item);
      continue;
    }
    seen.add(key);
    kept.push(item);
  }

  return {
    items: kept,
    removed: removedItems.length,
    removedItems
  };
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase();
}

function searchBriefKey(brief: SearchBrief): string {
  return `${brief.provider}:${normalizeKey(brief.topic)}`;
}

function podcastEpisodeKey(episode: PodcastEpisode): string {
  const sourcePrefix =
    episode.sourceType && episode.sourceId
      ? `${episode.sourceType}:${episode.sourceId}`
      : episode.noteId;
  return `${sourcePrefix}:${episode.format}:${normalizeKey(episode.voice)}:${normalizeKey(episode.title)}`;
}

function corpusInsightKey(insight: CorpusInsight): string {
  return normalizeKey(insight.title);
}
