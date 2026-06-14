import type {
  CognitiveRadar,
  MonthlyReview,
  ProductState,
  YearlyReview,
} from "./types";

import { cloneState, makeId, nowIso, withAuditEvent, withAiRunEvent } from "./utils";

export function buildCognitiveRadar(state: ProductState): CognitiveRadar {
  const noteText = state.notes.flatMap((note) => [note.summary, ...note.saidTrack, ...note.learnedTrack]).join(" ");
  const countSignal = (signals: string[]) => signals.reduce((count, signal) => count + (noteText.includes(signal) ? 1 : 0), 0);
  const max = Math.max(6, state.notes.length + state.points.length + state.questions.length);

  return {
    depth: [
      { label: "事实", value: Math.max(1, countSignal(["发生", "事件", "项目"])), max },
      { label: "机制", value: Math.max(1, countSignal(["机制", "系统", "奖励"])), max },
      { label: "感受", value: Math.max(1, countSignal(["担心", "不想", "怕"])), max },
      { label: "意义", value: Math.max(1, countSignal(["意味着", "边界", "长期"])), max },
      { label: "验证", value: Math.max(1, countSignal(["验证", "复盘", "测试"])), max }
    ],
    perspectives: [
      { label: "系统论", value: state.themes.filter((theme) => theme.summary.includes("机制") || theme.summary.includes("系统")).length + 1, max },
      { label: "心理学", value: countSignal(["担心", "信任", "控制感"]), max },
      { label: "形式科学", value: state.questions.length, max },
      { label: "叙事", value: state.notes.length, max }
    ],
    assets: [
      { label: "观点", value: state.points.length, max },
      { label: "问题", value: state.questions.length, max },
      { label: "决策", value: state.decisions.length, max },
      { label: "知识债", value: state.debts.length, max }
    ],
    statuses: [
      { label: "用户确认", value: state.points.filter((point) => point.confidence === "用户确认").length, max },
      { label: "待验证", value: state.points.filter((point) => point.confidence === "待验证").length, max },
      { label: "被挑战", value: state.points.filter((point) => point.status === "被挑战中").length, max },
      { label: "已应用", value: state.debts.filter((debt) => debt.status === "已应用").length, max }
    ]
  };
}
export function buildMonthlyReview(state: ProductState): MonthlyReview {
  const topTheme = [...state.themes].sort((a, b) => b.appearances - a.appearances)[0];
  const openQuestion = state.questions.find((question) => question.status !== "阶段性回答");

  return {
    topTheme: topTheme?.name ?? "暂无长期主题",
    changedView: deriveChangedView(state),
    avoidedQuestion: openQuestion?.question ?? "还没有形成明确的回避问题。",
    recommendedNextInterview: topTheme?.nextQuestion ?? "从最近一条关键原话继续。",
    metrics: {
      notes: state.notes.length,
      points: state.points.length,
      questions: state.questions.length,
      knowledgeDebts: state.debts.length,
      themes: state.themes.length
    }
  };
}

function deriveChangedView(state: ProductState): string {
  const candidates = state.points
    .filter((point) => point.status === "已修正" || point.status === "被挑战中")
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));

  const top = candidates[0];
  if (top) {
    const verb = top.status === "已修正" ? "已修正" : "正在被挑战";
    const summary = top.content?.trim() || top.title;
    return `${verb}：${summary}`;
  }

  if (state.points.length === 0) {
    return "本月还没有形成正在变化的观点。";
  }

  const stable = state.points.find((point) => point.status === "稳定观点");
  if (stable) {
    return `本月观点保持稳定：${stable.title}`;
  }

  return `本月共记录 ${state.points.length} 条观点，尚未触发修正或挑战。`;
}
export function buildYearlyReview(state: ProductState): YearlyReview {
  const coreQuestions = state.questions.slice(0, 3).map((question) => question.question);
  const changedViews = state.points
    .filter((point) => point.status === "已修正" || point.status === "被挑战中")
    .slice(0, 3)
    .map((point) => point.title);
  const unresolvedPatterns = state.themes
    .filter((theme) => theme.maturity !== "关闭")
    .slice(0, 3)
    .map((theme) => `${theme.name}：${theme.nextQuestion}`);
  const importantDecisions = state.decisions.slice(0, 3).map((decision) => decision.title);
  const usedPerspectiveWords = state.notes.map((note) => `${note.summary} ${note.learnedTrack.join(" ")}`).join(" ");
  const missingPerspectives = ["哲学", "人类学", "叙事"].filter((perspective) => !usedPerspectiveWords.includes(perspective));

  return {
    coreQuestions,
    changedViews: changedViews.length > 0
      ? changedViews
      : [deriveChangedView(state)],
    unresolvedPatterns,
    importantDecisions,
    missingPerspectives,
    nextYearFocus: "继续追踪控制感、授权机制和问题定义权之间的关系。"
  };
}
