import type {
  InterviewCard,
  InterviewSession,
} from "./types";

export function buildRealtimeVoiceInstructions(session: InterviewSession | null, fallbackCard?: InterviewCard) {
  const guide = session?.guide;
  const card = session?.card ?? fallbackCard;
  const historyReferences = card?.historyReferences?.slice(0, 3) ?? [];
  const sourceHighlights = card?.sourceHighlights?.slice(0, 3) ?? [];
  const relevantMemories = guide?.relevantMemories.slice(0, 3) ?? [];
  const graphReferences = guide?.graphReferences.slice(0, 3) ?? [];
  const appliedPlaybookRules = session?.enginePolicy?.appliedPlaybookRules.slice(0, 5) ?? [];
  const qualityGuardrails = session?.enginePolicy?.qualityGuardrails.slice(0, 3) ?? [];

  return [
    "你是一个真正的私人专访主持人。",
    "每次只问一个核心问题，优先追具体事件、真实张力和可验证假设。",
    "实时语音规则：允许短反馈；用户打断时立刻停止输出，把控制权还给用户；沉默时先留白，不要急着填满。",
    `本次主题：${session?.title ?? card?.title ?? "未命名专访"}`,
    card?.whyNow ? `为什么现在聊：${card.whyNow}` : "",
    card?.suggestedOpening ? `建议开场：${card.suggestedOpening}` : "",
    guide ? `推荐视角：${guide.recommendedPerspectives.join(" / ")}。理由：${guide.perspectiveRationale}` : "",
    guide?.debtToAddress ? `待追问知识债：${guide.debtToAddress}。${guide.openDebts[0]?.nextQuestion ?? ""}` : "",
    guide?.blindspotCandidates[0]
      ? `盲区候选：${guide.blindspotCandidates[0].concept}。${guide.blindspotCandidates[0].reason}`
      : "",
    historyReferences.length > 0 ? `历史引用：${historyReferences.join("；")}` : "",
    relevantMemories.length > 0 ? `可引用记忆：${relevantMemories.join("；")}` : "",
    graphReferences.length > 0 ? `记忆图谱依据：${graphReferences.map((reference) => reference.reason).join("；")}` : "",
    sourceHighlights.length > 0
      ? `联网素材：${sourceHighlights.map((source) => `${source.title}｜${source.snippet}`).join("；")}`
      : "",
    appliedPlaybookRules.length > 0
      ? `已确认的访谈样本技法：${appliedPlaybookRules.join("；")}`
      : "",
    qualityGuardrails.length > 0 ? `质量修复护栏：${qualityGuardrails.join("；")}` : "",
    guide ? `策略清单：${guide.strategyChecklist.slice(0, 3).join("；")}` : "",
    "不要长篇输出，不要替用户下结论，不要像客服。"
  ].filter(Boolean).join("\n");
}
