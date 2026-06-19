import { INTERVIEWER_CRAFT_RULES, buildVoiceOpeningDiscipline } from "./interviewer-craft";
import type { InterviewCard, InterviewSession, MemoryCorrection } from "./types";

// Bounds for what we surface into the realtime voice prompt. Kept small so the
// instruction string stays focused and the LLM actually honours it.
const MAX_VOICE_PLAYBOOK_RULES = 3;
const MAX_VOICE_CORRECTIONS = 10;

// Exported so the cascade/text interview path (apps/api/.../bailian.ts:
// buildCharacterSystemPrompt) injects the SAME "applied playbook技法 / 已纠正表述"
// copy as the LiveKit voice path — one source of truth instead of two divergent
// implementations.
export function buildAppliedPlaybookRulesBlock(rules: string[]): string {
  const applied = rules.map((rule) => rule.trim()).filter(Boolean).slice(0, MAX_VOICE_PLAYBOOK_RULES);
  if (applied.length === 0) {
    return "";
  }
  const numbered = applied.map((rule, index) => `${index + 1}. ${rule}`).join(" ");
  return `已应用的提问技法（追问时请自然体现，不要照念）：${numbered}`;
}

export function buildCorrectionsBlock(corrections: MemoryCorrection[]): string {
  const recent = [...corrections]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, MAX_VOICE_CORRECTIONS)
    .map((correction) => correction.text.trim())
    .filter(Boolean);
  if (recent.length === 0) {
    return "";
  }
  return `用户已纠正过的表述（别再当成已确认事实，必要时先核对）：${recent.join("；")}`;
}

export function buildRealtimeVoiceInstructions(
  session: InterviewSession | null,
  fallbackCard?: InterviewCard,
  corrections: MemoryCorrection[] = []
) {
  const card = session?.card ?? fallbackCard;
  const guide = session?.guide;
  const appliedRules = session?.enginePolicy?.appliedPlaybookRules ?? [];
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
    guide?.recommendedPerspectives?.length ? `建议视角（以一个自然问题呈现，别讲理论课）：${guide.recommendedPerspectives.slice(0, 3).join("、")}` : "",
    buildAppliedPlaybookRulesBlock(appliedRules),
    buildCorrectionsBlock(corrections)
  ].filter(Boolean).join("\n");
}
