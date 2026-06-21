// LLM-backed review synthesis. The quantitative parts (radar metrics, monthly
// metrics) stay deterministic — they're real counts, not narrative. Only the
// NARRATIVE fields (changedView, avoidedQuestion, yearly synthesis, nextYearFocus)
// are produced by the LLM over the user's real assets. Falls back to the
// deterministic review on any failure.
import { buildCognitiveRadar, buildMonthlyReview, buildYearlyReview } from "../../../../src/domain/engine";
import type { CognitiveRadar, MonthlyReview, ProductState, YearlyReview } from "../../../../src/domain/types";
import type { BailianChatClient } from "../providers/bailian";
import { asObject, asString, asStringArray, parseJsonObjectLoose} from "./llm-json";

export interface ReviewsBundle {
  monthly: MonthlyReview;
  yearly: YearlyReview;
  radar: CognitiveRadar;
}

export function buildDeterministicReviews(state: ProductState): ReviewsBundle {
  return {
    monthly: buildMonthlyReview(state),
    yearly: buildYearlyReview(state),
    radar: buildCognitiveRadar(state)
  };
}

const SYSTEM_PROMPT = [
  "你是一位长期跟踪用户思考的认知分析师。基于用户的真实资产（观点/问题/决策/知识债/主题/笔记），写出有洞察的回顾叙事。",
  "铁律：只能基于提供的真实资产，不要编造用户没有的内容；importantDecisions 必须来自给定的决策列表。",
  "如果数据很少，就少写几条，宁缺毋滥。只输出一个 JSON 对象。"
].join("\n");

export async function buildReviewsWithLlm(state: ProductState, chatClient: BailianChatClient): Promise<ReviewsBundle> {
  const base = buildDeterministicReviews(state);
  // Not enough material to synthesize anything meaningful — keep deterministic.
  if (state.notes.length === 0 && state.points.length === 0 && state.questions.length === 0) {
    return base;
  }

  const raw = await chatClient.complete({
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildReviewPrompt(state) }
    ],
    responseFormat: "json",
    temperature: 0.5
  });

  const parsed = parseJsonObjectLoose(raw);
  if (!parsed) {
    throw new Error("LLM returned unparseable JSON");
  }
  const monthlyJson = asObject(parsed.monthly);
  const yearlyJson = asObject(parsed.yearly);

  return {
    radar: base.radar, // counts stay deterministic
    monthly: {
      ...base.monthly, // keep metrics (real counts)
      topTheme: asString(monthlyJson.topTheme) || base.monthly.topTheme,
      changedView: asString(monthlyJson.changedView) || base.monthly.changedView,
      avoidedQuestion: asString(monthlyJson.avoidedQuestion) || base.monthly.avoidedQuestion,
      recommendedNextInterview: asString(monthlyJson.recommendedNextInterview) || base.monthly.recommendedNextInterview
    },
    yearly: {
      coreQuestions: asStringArray(yearlyJson.coreQuestions, base.yearly.coreQuestions),
      changedViews: asStringArray(yearlyJson.changedViews, base.yearly.changedViews),
      unresolvedPatterns: asStringArray(yearlyJson.unresolvedPatterns, base.yearly.unresolvedPatterns),
      importantDecisions: asStringArray(yearlyJson.importantDecisions, base.yearly.importantDecisions),
      missingPerspectives: asStringArray(yearlyJson.missingPerspectives, base.yearly.missingPerspectives),
      nextYearFocus: asString(yearlyJson.nextYearFocus) || base.yearly.nextYearFocus
    }
  };
}

function buildReviewPrompt(state: ProductState): string {
  const themes = state.themes
    .slice(0, 12)
    .map((theme) => `${theme.name}（成熟度${theme.maturity}，出现${theme.appearances}次）`);
  const points = state.points
    .slice(0, 20)
    .map((point) => `[${point.status}] ${point.title}`);
  const questions = state.questions.slice(0, 20).map((question) => `[${question.status}] ${question.question}`);
  const decisions = state.decisions.slice(0, 15).map((decision) => decision.title);
  const debts = state.debts.slice(0, 15).map((debt) => debt.concept);
  const recentNotes = state.notes
    .slice(0, 8)
    .map((note) => `· ${note.summary}${note.learnedTrack.length ? `（学到：${note.learnedTrack[0]}）` : ""}`);

  return [
    "=== 用户真实资产 ===",
    `长期主题：${themes.join("、") || "（无）"}`,
    `观点：\n${points.join("\n") || "（无）"}`,
    `问题：\n${questions.join("\n") || "（无）"}`,
    `决策：${decisions.join("、") || "（无）"}`,
    `知识债：${debts.join("、") || "（无）"}`,
    `近期双轨笔记：\n${recentNotes.join("\n") || "（无）"}`,
    "=== 资产结束 ===",
    "",
    "请输出以下结构的 JSON（基于上面的真实资产，叙事要具体、有洞察）：",
    `{
  "monthly": {
    "topTheme": "本月最突出的主题名（从已有主题里选）",
    "changedView": "本月最明显在变化或被挑战的一个观点，一句话",
    "avoidedQuestion": "用户似乎一直在回避、但很关键的一个问题",
    "recommendedNextInterview": "下次最值得继续聊什么，一句话邀请"
  },
  "yearly": {
    "coreQuestions": ["本年（迄今）最核心的 2-3 个问题"],
    "changedViews": ["明显发生变化的观点，2-3 条"],
    "unresolvedPatterns": ["反复出现却仍未解决的模式，2-3 条"],
    "importantDecisions": ["最重要的决策，必须来自上面的决策列表"],
    "missingPerspectives": ["用户很少使用、值得补的认知视角，如 哲学/人类学/系统论/叙事 等"],
    "nextYearFocus": "下一阶段最值得持续追踪的认知主线，一句话"
  }
}`
  ].join("\n");
}
