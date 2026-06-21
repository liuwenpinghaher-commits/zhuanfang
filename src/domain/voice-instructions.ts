import { INTERVIEWER_CRAFT_RULES, buildVoiceOpeningDiscipline } from "./interviewer-craft";
import type { InterviewCard, InterviewSession, MemoryCorrection } from "./types";

// Bounds for what we surface into the realtime voice prompt. Kept small so the
// instruction string stays focused and the LLM actually honours it.
// Recall-freshness caveat (honest, per-path):
//  - Cascade/text interview path: rebuilds memory recall on every /turns request (a fresh
//    queryEmbedding from the latest user turn), so relevantMemories track the conversation.
//  - Bailian omni voice path (WS/WebRTC): the realtime session sets these instructions ONCE
//    at open (an opening-time snapshot), BUT the client now refreshes them per user turn via
//    POST /api/interview-sessions/:id/voice-instructions → connection.updateInstructions
//    (session.update). So this path's recall ALSO tracks the conversation now (fills 🔴-1).
//  - LiveKit cascade voice path: instructions live in the Python agent. It now re-fetches
//    GET /agent-context/:id?latestUserText=<utterance> on every user turn (agent/main.py
//    on_user_turn_completed → update_instructions), and that endpoint re-ranks recall by the
//    utterance's queryEmbedding — so this path's recall ALSO tracks the conversation now.
// All three paths track recall now; they differ only in WHO triggers the per-turn refresh
// (/turns for cascade-text, client session.update for bailian omni, Python agent for livekit).
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

/**
 * Hard user-set boundaries (profile.explicitBoundaries). Unlike corrections (which soften how the
 * AI phrases things), boundaries are lines the interviewer must NOT cross — rendered as a strong,
 * non-negotiable directive so they actually constrain the prompt instead of being decorative.
 */
export function buildBoundariesBlock(boundaries: string[]): string {
  const clean = boundaries.map((b) => (typeof b === "string" ? b.trim() : "")).filter(Boolean);
  if (clean.length === 0) {
    return "";
  }
  return `【用户硬性边界·绝不违反】这些是用户明确设定、不可逾越的边界，无论话题如何发展都必须遵守；若对话逼近，主动而温和地绕开，绝不追问或越界：\n${clean
    .map((b) => `- ${b}`)
    .join("\n")}`;
}

export function buildRealtimeVoiceInstructions(
  session: InterviewSession | null,
  fallbackCard?: InterviewCard,
  corrections: MemoryCorrection[] = [],
  boundaries: string[] = []
) {
  const card = session?.card ?? fallbackCard;
  const guide = session?.guide;
  const appliedRules = session?.enginePolicy?.appliedPlaybookRules ?? [];
  // 质量护栏：上一场质量门 / 记忆修正 / 实时轮替失败沉淀出的「本场提问纪律」。
  // 由 domain 侧 buildInterviewEnginePolicy → buildQualityGuardrails 填充（本场我方系统生成，
  // 非外部不可信内容），是产品核心学习闭环在语音路径上的落点。空时不注入。
  // 与文本路 buildCharacterSystemPrompt 使用同一份措辞，保持单一事实来源。
  const qualityGuardrails = (session?.enginePolicy?.qualityGuardrails ?? [])
    .map((rule) => (typeof rule === "string" ? rule.trim() : ""))
    .filter(Boolean);
  const qualityGuardrailsBlock = qualityGuardrails.length
    ? `【本场提问纪律·质量护栏】（基于过往复盘得出，本场务必照做）：\n${qualityGuardrails.map((rule) => `- ${rule}`).join("\n")}`
    : "";
  return [
    card ? buildVoiceOpeningDiscipline(card) : "",
    "",
    INTERVIEWER_CRAFT_RULES,
    "",
    "【语音节奏】允许短反馈；用户一打断立刻停、把控制权还给用户；沉默时先留白，不要急着填满。不长篇、不替对方下结论、不像客服。",
    qualityGuardrailsBlock,
    "",
    `本次主题：${session?.title ?? card?.title ?? "未命名专访"}`,
    card?.whyNow ? `为什么现在聊：${card.whyNow}` : "",
    guide?.debtToAddress ? `待追问知识债：${guide.debtToAddress}。${guide.openDebts?.[0]?.nextQuestion ?? ""}` : "",
    guide?.blindspotCandidates?.[0] ? `盲区候选：${guide.blindspotCandidates[0].concept}。${guide.blindspotCandidates[0].reason}` : "",
    (guide?.relevantMemories ?? []).length ? `可引用记忆/历史：${guide!.relevantMemories.slice(0, 3).join("；")}` : "",
    (guide?.statedPositions ?? []).length ? `用户过去的立场（出现矛盾就温和点出）：${guide!.statedPositions.slice(0, 3).join("；")}` : "",
    (guide?.opinionEvolution ?? []).length ? `观点演变（可顺势确认变化是否成立）：${guide!.opinionEvolution.slice(0, 2).map((e) => `「${e.topic}」从「${e.oldView}」到「${e.newView}」`).join("；")}` : "",
    (guide?.graphReferences ?? []).length ? `相关长期主题（合适时把当下话题接回其中一条，别生硬切换）：${Array.from(new Set(guide!.graphReferences.map((r) => r.themeLabel).filter(Boolean))).slice(0, 3).join("、")}` : "",
    (card?.historyReferences ?? []).length ? `历史原话：${card!.historyReferences.slice(0, 3).join("；")}` : "",
    (card?.sourceHighlights ?? []).length ? `全网素材：${card!.sourceHighlights!.slice(0, 2).map((s) => `${s.title}｜${s.snippet}`).join("；")}` : "",
    (guide?.knowledgeFragments ?? []).length ? `调研要点（自然相关时引一条作事实/反方依据，务必回到用户自己的经历，别堆资料）：${guide!.knowledgeFragments.slice(0, 2).join("；")}` : "",
    guide?.recommendedPerspectives?.length ? `建议视角（以一个自然问题呈现，别讲理论课）：${guide.recommendedPerspectives.slice(0, 3).join("、")}` : "",
    buildAppliedPlaybookRulesBlock(appliedRules),
    buildBoundariesBlock(boundaries),
    buildCorrectionsBlock(corrections)
  ].filter(Boolean).join("\n");
}
