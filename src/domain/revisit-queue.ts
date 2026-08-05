/**
 * Cognitive revisit queue — single source for "why interview today" (loop Phase A).
 * Priority is fixed and testable; Home / card / launch share this ranking.
 */
import type { DecisionAsset, InterviewMode, ProductState } from "./types";
import { daysBetween, nowIso } from "./utils";

export type RevisitKind =
  | "resume_session"
  | "memory_hitl"
  | "decision_due"
  | "debt_open"
  | "theme_next"
  | "focus_question"
  | "cold_start";

export type RevisitHrefView =
  | "home"
  | "interview"
  | "memory"
  | "notes"
  | "my-assets"
  | "themes"
  | "track";

export interface RevisitItem {
  id: string;
  kind: RevisitKind;
  /** Lower = higher priority (1 = resume … 7 = cold). */
  priority: number;
  title: string;
  reason: string;
  mode?: InterviewMode;
  topicHint?: string;
  relatedThemeIds?: string[];
  /** Resume target. */
  sessionId?: string;
  href?: { view: RevisitHrefView; focusId?: string };
  /** True when primary CTA should open a new/continued interview (not only navigate). */
  canLaunchInterview: boolean;
}

export interface InterviewLaunchRecommendation {
  mode: InterviewMode;
  topicHint?: string;
  relatedThemeIds?: string[];
  reason: string;
  /** First queue item that can drive an interview (skips memory_hitl-only). */
  launchItem: RevisitItem;
  queue: RevisitItem[];
  pendingMemoryCount: number;
}

function decisionMadeAt(state: ProductState, decision: DecisionAsset): string {
  if (decision.sourceSessionId) {
    const session = state.sessions.find((s) => s.id === decision.sourceSessionId);
    if (session?.completedAt) return session.completedAt;
  }
  if (decision.reviewAt) {
    const t = Date.parse(decision.reviewAt) - 30 * 86400000;
    if (!Number.isNaN(t)) return new Date(t).toISOString();
  }
  return decision.updatedAt;
}

/** Same gates as buildInterviewGuide decisionsToReview (R5-1/R5-2). */
export function listDueDecisionsForRevisit(state: ProductState, now: string = nowIso()) {
  return state.decisions
    .filter(
      (decision) =>
        decision.status === "待复盘" &&
        decision.confirmationStatus === "用户确认" &&
        (!decision.reviewAt || Date.parse(decision.reviewAt) <= Date.parse(now))
    )
    .map((decision) => ({
      decision,
      daysOpen: daysBetween(decisionMadeAt(state, decision), now)
    }))
    .sort((a, b) => b.daysOpen - a.daysOpen);
}

function findFocusQuestion(state: ProductState) {
  return state.questions.find(
    (question) =>
      question.status === "正在聚焦" &&
      question.important &&
      question.whyImportant.includes("会后反馈")
  );
}

/**
 * Build ordered cognitive revisit queue for Home + launch + loop golden.
 * Does not mutate state.
 */
export function buildCognitiveRevisitQueue(
  state: ProductState,
  now: string = nowIso()
): RevisitItem[] {
  const items: RevisitItem[] = [];

  const activeSessions = state.sessions
    .filter((s) => s.status === "active")
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  for (const session of activeSessions) {
    items.push({
      id: `resume:${session.id}`,
      kind: "resume_session",
      priority: 1,
      title: `继续：${session.title}`,
      reason: session.turns.length === 0 ? "有未开始的空场，优先接上或移除。" : `未完成专访，已 ${session.turns.length} 轮。`,
      mode: session.mode,
      topicHint: session.guide?.topicHint || session.card?.title,
      relatedThemeIds: session.relatedThemeIds,
      sessionId: session.id,
      href: { view: "interview", focusId: session.id },
      canLaunchInterview: true
    });
  }

  const pendingMemoryCount = state.memoryCandidates.filter((c) => c.status === "pending").length;
  if (pendingMemoryCount > 0) {
    items.push({
      id: "memory_hitl",
      kind: "memory_hitl",
      priority: 2,
      title: `${pendingMemoryCount} 条记忆待确认`,
      reason: "未确认的记忆不会进入跨会话召回；先审核再开专访更稳。",
      href: { view: "memory" },
      canLaunchInterview: false
    });
  }

  const due = listDueDecisionsForRevisit(state, now);
  if (due[0]) {
    const { decision, daysOpen } = due[0];
    items.push({
      id: `decision:${decision.id}`,
      kind: "decision_due",
      priority: 3,
      title: `复盘决策：${decision.title}`,
      reason: `「${decision.title}」已做出约 ${daysOpen} 天（选「${decision.choice}」），适合回访当初假设是否成立。`,
      mode: "decision",
      topicHint: decision.title,
      relatedThemeIds: decision.relatedThemeIds,
      href: { view: "interview" },
      canLaunchInterview: true
    });
  }

  const openDebts = state.debts
    .filter((d) => d.status === "待了解")
    .map((d) => ({ debt: d, daysOpen: daysBetween(d.updatedAt, now) }))
    .sort((a, b) => b.daysOpen - a.daysOpen);
  if (openDebts[0]) {
    const { debt, daysOpen } = openDebts[0];
    items.push({
      id: `debt:${debt.id}`,
      kind: "debt_open",
      priority: 4,
      title: `回访知识债：${debt.concept}`,
      reason: `「${debt.concept}」已开放约 ${daysOpen} 天：${debt.nextQuestion || debt.context || "还缺一次落地追问。"}`,
      mode: "learning",
      topicHint: debt.concept,
      relatedThemeIds: debt.relatedThemeIds,
      href: { view: "interview" },
      canLaunchInterview: true
    });
  }

  const openThemes = [...state.themes]
    .filter((t) => t.maturity !== "关闭" && t.nextQuestion.trim())
    .sort((a, b) => b.appearances - a.appearances);
  if (openThemes[0]) {
    const theme = openThemes[0];
    items.push({
      id: `theme:${theme.id}`,
      kind: "theme_next",
      priority: 5,
      title: `主题线：${theme.name}`,
      reason: theme.summary
        ? `继续「${theme.name}」：${theme.summary}`
        : `继续「${theme.name}」的下一问：${theme.nextQuestion}`,
      mode: "long-term",
      topicHint: theme.nextQuestion || theme.name,
      relatedThemeIds: [theme.id],
      href: { view: "track", focusId: theme.id },
      canLaunchInterview: true
    });
  }

  const focus = findFocusQuestion(state);
  if (focus) {
    items.push({
      id: `focus:${focus.id}`,
      kind: "focus_question",
      priority: 6,
      title: `继续追问：${focus.question}`,
      reason: "会后反馈标记为「值得下次继续」的问题，应直接接上。",
      mode: "daily",
      topicHint: focus.question,
      relatedThemeIds: focus.relatedThemeIds,
      href: { view: "interview" },
      canLaunchInterview: true
    });
  }

  if (items.length === 0 || items.every((i) => i.kind === "resume_session")) {
    // cold_start only when nothing else to do after resumes (or empty)
    const hasNonResume = items.some((i) => i.kind !== "resume_session");
    if (!hasNonResume && items.filter((i) => i.kind === "resume_session").length === 0) {
      items.push({
        id: "cold_start",
        kind: "cold_start",
        priority: 7,
        title: "今天想聊点什么？",
        reason: state.profile.currentFocus
          ? `从当前关注「${state.profile.currentFocus}」或最近一件具体事开始。`
          : "从最近发生的一件具体事情开始，先落到可核验时刻。",
        mode: "daily",
        topicHint: state.profile.currentFocus || undefined,
        href: { view: "interview" },
        canLaunchInterview: true
      });
    }
  }

  return items.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
}

export function countPendingMemoryCandidates(state: ProductState): number {
  return state.memoryCandidates.filter((c) => c.status === "pending").length;
}

/**
 * Launch recommendation for Home / createSessionDraft (skips pure HITL navigate items
 * when choosing mode/topic; still surfaces them in queue for UI).
 */
export function pickInterviewLaunchRecommendation(
  state: ProductState,
  options: { searchBriefId?: string; now?: string } = {}
): InterviewLaunchRecommendation {
  const now = options.now ?? nowIso();
  const queue = buildCognitiveRevisitQueue(state, now);
  const pendingMemoryCount = countPendingMemoryCandidates(state);

  if (options.searchBriefId) {
    const brief = state.searchBriefs.find((b) => b.id === options.searchBriefId);
    const launchItem: RevisitItem = {
      id: `brief:${options.searchBriefId}`,
      kind: "cold_start",
      priority: 0,
      title: brief ? `消化简报：${brief.topic}` : "消化外部材料",
      reason: "适合先消化外部材料，再回到你的真实经验。",
      mode: "learning",
      topicHint: brief?.topic,
      canLaunchInterview: true,
      href: { view: "interview" }
    };
    return {
      mode: "learning",
      topicHint: brief?.topic,
      reason: launchItem.reason,
      launchItem,
      queue,
      pendingMemoryCount
    };
  }

  const launchItem =
    queue.find((item) => item.canLaunchInterview && item.kind !== "resume_session") ??
    queue.find((item) => item.canLaunchInterview) ??
    ({
      id: "cold_start",
      kind: "cold_start" as const,
      priority: 7,
      title: "今天想聊点什么？",
      reason: "先从最近发生的一件具体事情开始",
      mode: "daily" as const,
      canLaunchInterview: true
    } satisfies RevisitItem);

  return {
    mode: launchItem.mode ?? "daily",
    topicHint: launchItem.topicHint,
    relatedThemeIds: launchItem.relatedThemeIds,
    reason: launchItem.reason,
    launchItem,
    queue,
    pendingMemoryCount
  };
}

/** Revisit suppress keys used by strategy (decision:title / debt:concept). */
export function revisitSuppressKey(
  kind: "decision" | "debt",
  label: string
): string {
  return `${kind}:${label.trim()}`;
}

export function isRevisitSuppressed(
  suppressed: string[] | undefined,
  kind: "decision" | "debt",
  label: string
): boolean {
  if (!suppressed?.length) return false;
  const key = revisitSuppressKey(kind, label);
  return suppressed.includes(key);
}

/** Append a suppress key on the session (immutable). */
export function suppressRevisitOnSession<T extends { suppressedRevisitIds?: string[] }>(
  session: T,
  kind: "decision" | "debt",
  label: string
): T {
  const key = revisitSuppressKey(kind, label);
  const prev = session.suppressedRevisitIds ?? [];
  if (prev.includes(key)) return session;
  return { ...session, suppressedRevisitIds: [...prev, key] };
}
