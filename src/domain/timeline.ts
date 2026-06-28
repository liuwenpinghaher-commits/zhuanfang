/**
 * timeline.ts — 领域纯函数：时间轴聚合 + 主题线工作区聚合
 *
 * 两个导出函数均为纯函数，不产生副作用，不依赖外部 IO。
 */

import type {
  ProductState,
  InterviewSession,
  ImportSource,
  PointAsset,
  QuestionAsset,
  DecisionAsset,
  KnowledgeDebt,
  LongTermTheme,
} from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type TimelineEventKind = "session" | "note" | "theme";

export interface TimelineOutputCount {
  label: string;
  count: number;
}

export interface TimelineHref {
  view: "interview" | "notes" | "track";
  trackId?: string;
}

export interface TimelineEvent {
  id: string;
  kind: TimelineEventKind;
  /** ISO 8601 timestamp used for sorting */
  at: string;
  title: string;
  summary?: string;
  themeIds: string[];
  outputs: TimelineOutputCount[];
  href: TimelineHref;
}

// ─────────────────────────────────────────────────────────────────────────────
// buildTimeline
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 将 sessions / notes / themes 聚合成按时间倒序排列的事件列表。
 *
 * @param state  ProductState 快照
 * @param limit  最多返回条数，默认 30
 */
export function buildTimeline(state: ProductState, limit = 30): TimelineEvent[] {
  const events: TimelineEvent[] = [];

  // 会话事件
  for (const session of state.sessions) {
    events.push({
      id: `session:${session.id}`,
      kind: "session",
      at: session.startedAt,
      title: session.title,
      summary: session.card?.whyNow,
      themeIds: session.relatedThemeIds ?? [],
      outputs: buildSessionOutputCounts(session, state),
      href: { view: "interview" },
    });
  }

  // 笔记事件
  for (const note of state.notes) {
    events.push({
      id: `note:${note.id}`,
      kind: "note",
      at: note.createdAt,
      title: note.title,
      summary: note.summary,
      themeIds: note.relatedThemeIds ?? [],
      outputs: [],
      href: { view: "notes" },
    });
  }

  // 主题线事件（Track）
  for (const theme of state.themes) {
    const at = theme.createdAt ?? theme.updatedAt;
    events.push({
      id: `theme:${theme.id}`,
      kind: "theme",
      at,
      title: `主题线「${theme.name}」`,
      summary: theme.summary,
      themeIds: [theme.id],
      outputs: [{ label: "出现", count: theme.appearances }],
      href: { view: "track", trackId: theme.id },
    });
  }

  // 按 at 倒序
  events.sort((a, b) => {
    if (a.at > b.at) return -1;
    if (a.at < b.at) return 1;
    return 0;
  });

  return events.slice(0, limit);
}

/** 统计一个会话关联的笔记数 */
function buildSessionOutputCounts(
  session: InterviewSession,
  state: ProductState
): TimelineOutputCount[] {
  const noteCount = state.notes.filter((n) => n.sessionId === session.id).length;
  if (noteCount === 0) return [];
  return [{ label: "笔记", count: noteCount }];
}

// ─────────────────────────────────────────────────────────────────────────────
// TrackWorkspace
// ─────────────────────────────────────────────────────────────────────────────

export interface TrackWorkspaceOutputs {
  points: PointAsset[];
  questions: QuestionAsset[];
  decisions: DecisionAsset[];
  debts: KnowledgeDebt[];
}

export interface TrackWorkspace {
  theme: LongTermTheme | undefined;
  /** 资料来源列表：通过 relatedThemeIds 软标签归属到本主题线的 ImportSource。 */
  sources: ImportSource[];
  sessions: InterviewSession[];
  outputs: TrackWorkspaceOutputs;
}

/**
 * 聚合单条主题线（Track）的相关会话与输出资产。
 *
 * @param state    ProductState 快照
 * @param themeId  目标主题线 id
 */
export function buildTrackWorkspace(state: ProductState, themeId: string): TrackWorkspace {
  const theme = state.themes.find((t) => t.id === themeId);

  if (!theme) {
    return {
      theme: undefined,
      sources: [],
      sessions: [],
      outputs: { points: [], questions: [], decisions: [], debts: [] },
    };
  }

  const sources = state.importSources.filter((src) =>
    (src.relatedThemeIds ?? []).includes(themeId)
  );

  const sessions = state.sessions.filter((s) =>
    (s.relatedThemeIds ?? []).includes(themeId)
  );

  const points = state.points.filter((p) =>
    (p.relatedThemeIds ?? []).includes(themeId)
  );

  const questions = state.questions.filter((q) =>
    (q.relatedThemeIds ?? []).includes(themeId)
  );

  const decisions = state.decisions.filter((d) =>
    (d.relatedThemeIds ?? []).includes(themeId)
  );

  const debts = state.debts.filter((d) =>
    (d.relatedThemeIds ?? []).includes(themeId)
  );

  return {
    theme,
    sources,
    sessions,
    outputs: { points, questions, decisions, debts },
  };
}
