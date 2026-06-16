import { INTERVIEWER_CRAFT_RULES, buildVoiceOpeningDiscipline } from "./interviewer-craft";
import type { InterviewCard, InterviewSession } from "./types";

export function buildRealtimeVoiceInstructions(session: InterviewSession | null, fallbackCard?: InterviewCard) {
  const card = session?.card ?? fallbackCard;
  const guide = session?.guide;
  return [
    card ? buildVoiceOpeningDiscipline(card) : "",
    "",
    INTERVIEWER_CRAFT_RULES,
    "",
    "【语音节奏】允许短反馈；用户一打断立刻停、把控制权还给用户；沉默时先留白，不要急着填满。不长篇、不替对方下结论、不像客服。",
    "",
    `本次主题：${session?.title ?? card?.title ?? "未命名专访"}`,
    card?.whyNow ? `为什么现在聊：${card.whyNow}` : "",
    guide?.debtToAddress ? `待追问知识债：${guide.debtToAddress}。${guide.openDebts?.[0]?.nextQuestion ?? ""}` : "",
    guide?.blindspotCandidates?.[0] ? `盲区候选：${guide.blindspotCandidates[0].concept}。${guide.blindspotCandidates[0].reason}` : "",
    (guide?.relevantMemories ?? []).length ? `可引用记忆/历史：${guide!.relevantMemories.slice(0, 3).join("；")}` : "",
    (guide?.statedPositions ?? []).length ? `用户过去的立场（出现矛盾就温和点出）：${guide!.statedPositions.slice(0, 3).join("；")}` : "",
    (card?.historyReferences ?? []).length ? `历史原话：${card!.historyReferences.slice(0, 3).join("；")}` : "",
    (card?.sourceHighlights ?? []).length ? `全网素材：${card!.sourceHighlights!.slice(0, 2).map((s) => `${s.title}｜${s.snippet}`).join("；")}` : "",
    guide?.recommendedPerspectives?.length ? `建议视角（以一个自然问题呈现，别讲理论课）：${guide.recommendedPerspectives.slice(0, 3).join("、")}` : ""
  ].filter(Boolean).join("\n");
}
