// LLM-backed diary synthesis. Produces the dual-track note (双轨笔记) and
// long-term assets grounded in the ACTUAL conversation, replacing the
// deterministic "救火/授权" script. Throws on any LLM/parse failure so the
// route falls back to the deterministic finalizeSession.
import {
  mergeFinalizedState,
  type FinalizeContent,
  type FinalizeThemeUpsert
} from "../../../../src/domain/engine";
import { parseJsonObjectLoose } from "./llm-json";
import { makeId, nowIso } from "../../../../src/domain/utils";
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
  ProfileSuggestionField,
  QuestionAsset
} from "../../../../src/domain/types";
import type { BailianChatClient } from "../providers/bailian";

const THEME_MATURITIES: LongTermTheme["maturity"][] = ["萌芽", "重复", "聚焦", "成型", "变化", "关闭"];

const SYSTEM_PROMPT = [
  "你是一位资深专访编辑。一次专访结束后，你的任务是基于【真实对话内容】产出两样东西：",
  "1) 双轨笔记：轨道一「我说了什么」（用户的核心事件/判断/情绪/矛盾），轨道二「我学到了什么」（被挑战的假设、新视角、值得沉淀的问题）。",
  "2) 长期资产：观点、问题、决策、知识债、长期主题。",
  "铁律：只能基于用户真实说过的话，不许编造事实。keyQuote 和每条 evidence 必须是用户原话里的逐字片段。",
  "如果对话很浅、信息不足，就少产出资产（甚至只给 note），不要硬凑。",
  "只输出一个 JSON 对象，不要 Markdown、不要解释。"
].join("\n");

interface ParsedFinalize {
  summary: string;
  keyQuote: string;
  saidTrack: string[];
  learnedTrack: string[];
  nextQuestions: string[];
  points: Array<{ title: string; content: string; evidence: string[] }>;
  questions: Array<{ question: string; whyImportant: string; nextPrompt: string }>;
  decisions: Array<{ title: string; choice: string; tradeOff: string; riskHypothesis: string; reviewAt: string }>;
  debts: Array<{ concept: string; context: string; whyImportant: string; nextQuestion: string }>;
  themes: Array<{ name: string; summary: string; representativeQuote: string; nextQuestion: string; maturity: string }>;
  profileSuggestions: Array<{ field: string; suggestedValue: string; reason: string; evidenceQuote: string }>;
}

export async function finalizeSessionWithLlm(
  state: ProductState,
  session: InterviewSession,
  chatClient: BailianChatClient,
  providedCandidates?: MemoryCandidate[]
): Promise<FinalizeResult> {
  const completedAt = nowIso();
  const raw = await chatClient.complete({
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildFinalizePrompt(state, session) }
    ],
    responseFormat: "json",
    temperature: 0.4,
    // A rich 20K-char interview produces a large finalize JSON (note + points + questions +
    // decisions + debts + themes, each with quotes/evidence). The client default of 2048 tokens
    // truncates it mid-object → invalid JSON → degrade to a no-asset light record. 5000 gives
    // ample room (a full asset set is ~3000 tokens); the loose parser salvages the rest.
    maxTokens: 5000,
    // ...and generating that much over a dense 20K transcript takes well over the 60s default
    // for technical guests — which timed out → aborted → degrade. Allow up to 3 min.
    timeoutMs: 180000
  });

  const parsed = parseFinalizeJson(raw, session);
  const content = mapToFinalizeContent(parsed, state, session, completedAt);
  return mergeFinalizedState(state, session, content, completedAt, providedCandidates);
}

function buildFinalizePrompt(state: ProductState, session: InterviewSession): string {
  const transcript = session.turns
    .slice(-60)
    .map((turn) => `${turn.role === "user" ? "用户" : "主持人"}：${turn.content}`)
    .join("\n");

  // Feed ALL existing theme lines (name + a summary cue), most-recurring first, so the LLM can
  // recognize when this conversation continues one of them and reuse its exact name (which then
  // merges in upsertFinalizeThemes). The old slice(0,12) hid older themes → guaranteed fragmentation.
  const existingThemes = [...state.themes]
    .sort((a, b) => b.appearances - a.appearances)
    .slice(0, 40)
    .map((theme) => `「${theme.name}」（${(theme.summary ?? "").slice(0, 28)}）`);
  const openDebts = (session.guide?.openDebts ?? []).map((debt) => debt.concept).slice(0, 8);
  const blindspots = (session.guide?.blindspotCandidates ?? []).map((b) => b.concept).slice(0, 8);

  return [
    "【唯一事实来源】是下面的完整对话记录。只能根据用户在对话中真实说过的话来写笔记、抽取资产。",
    "",
    "=== 完整对话记录（事实来源）===",
    transcript,
    "=== 对话记录结束 ===",
    "",
    "【以下仅为背景参考，可能与本次对话无关。若与上面的对话不一致，一律以对话为准；绝不要为了贴合背景而产出对话里根本没谈到的资产（例如对话没提到的话题）。】",
    `· 系统预设话题（可能与实际对话不符，仅供参考）：${session.title}`,
    `· 访谈模式：${session.mode}；追问强度：${session.strength}`,
    existingThemes.length
      ? `· 已有长期主题线（仅当本次对话确实是在【延续】其中某一条——同一个反复出现的问题/张力——时，才【逐字沿用它的名称】让它累积成一条线、出现次数+1；如果本次只是话题相关、角度不同、或你拿不准，就按真实内容【另起一条新主题】，绝不要把新话题硬塞进某条既有主题）：\n${existingThemes.join("\n")}`
      : "",
    `· 现有档案（用于对比，判断是否需要在 profileSuggestions 里提出更新；不需要就留空）：当前关注=「${state.profile.currentFocus || "（未设置）"}」；长期目标=「${state.profile.longTermGoal || "（未设置）"}」`,
    openDebts.length ? `· 既往未还知识债（仅当本次对话真的涉及时才引用）：${openDebts.join("、")}` : "",
    blindspots.length ? `· 盲区候选（仅参考）：${blindspots.join("、")}` : "",
    "",
    "请输出以下结构的 JSON（字段含义见注释，列表可为空数组）：",
    `{
  "summary": "一句话：这次对话真正把哪个问题推进到了哪一步（基于真实内容）",
  "keyQuote": "用户原话里最关键的一句，必须逐字摘录",
  "saidTrack": ["我说了什么：3-5 条，复述用户真实表达的核心"],
  "learnedTrack": ["我学到了什么：2-5 条，被挑战的假设/新视角/留待深挖的问题"],
  "nextQuestions": ["下次值得继续追问的问题，1-3 条"],
  "points": [{"title":"观点标题","content":"观点内容","evidence":["支撑这个观点的用户原话"]}],
  "questions": [{"question":"值得长期追的问题","whyImportant":"为什么重要","nextPrompt":"下次怎么问"}],
  "decisions": [{"title":"决策标题","choice":"用户倾向的选择","tradeOff":"取舍","riskHypothesis":"风险假设","reviewAt":"复盘日期YYYY-MM-DD，没有就留空"}],
  "debts": [{"concept":"概念","context":"在本次对话中如何出现","whyImportant":"为什么值得补","nextQuestion":"下次的引导问题"}],
  "themes": [{"name":"主题名：必须是能在别的对话里再次认出的【可复现主题】——一个反复出现的问题/张力/取舍，不要用一次性金句、比喻或诗意短语当名字","summary":"这条主题在追踪什么，以及下次靠什么线索能认出它又出现了","representativeQuote":"代表性原话","nextQuestion":"下次追问","maturity":"按它真实出现过几次填：只出现一次就是萌芽，不要凭单次对话的深度就标成型/聚焦"}],
  "profileSuggestions": [{"field":"currentFocus 或 longTermGoal","suggestedValue":"用户【当前关注】或【长期目标】的新表述——仅当本次对话清楚显示它相比下面【现有档案】发生了实质变化、或第一次被明确说清时才填；只是顺带提到、与现状一致、或只是一次性感慨，就把整个数组留空[]","reason":"为什么这是一个真实、稳定的变化，而不是一次性发言","evidenceQuote":"支撑这个判断的用户原话"}]
}`
  ]
    .filter(Boolean)
    .join("\n");
}

function parseFinalizeJson(raw: string, session: InterviewSession): ParsedFinalize {
  // Tolerant parse: if the model truncated the JSON (despite the raised token cap), salvage
  // the assets it DID emit instead of throwing and degrading the whole finalize to a no-asset
  // light record.
  const json = parseJsonObjectLoose(raw);
  if (!json) {
    throw new Error("finalize LLM returned unparseable JSON");
  }

  const summary = asNonEmptyString(json.summary);
  const saidTrack = asStringArray(json.saidTrack);
  const learnedTrack = asStringArray(json.learnedTrack);
  if (!summary || saidTrack.length === 0 || learnedTrack.length === 0) {
    throw new Error("LLM finalize output missing required note fields (summary/saidTrack/learnedTrack).");
  }

  const fallbackQuote = pickLongestUserTurn(session);
  const keyQuote = asNonEmptyString(json.keyQuote) || fallbackQuote;
  if (!keyQuote) {
    throw new Error("LLM finalize output has no keyQuote and the session has no user turns.");
  }

  return {
    summary,
    keyQuote,
    saidTrack,
    learnedTrack,
    nextQuestions: asStringArray(json.nextQuestions),
    points: asObjectArray(json.points).map((p) => ({
      title: asNonEmptyString(p.title),
      content: asNonEmptyString(p.content),
      evidence: asStringArray(p.evidence)
    })).filter((p) => p.title && p.content),
    questions: asObjectArray(json.questions).map((q) => ({
      question: asNonEmptyString(q.question),
      whyImportant: asNonEmptyString(q.whyImportant),
      nextPrompt: asNonEmptyString(q.nextPrompt)
    })).filter((q) => q.question),
    decisions: asObjectArray(json.decisions).map((d) => ({
      title: asNonEmptyString(d.title),
      choice: asNonEmptyString(d.choice),
      tradeOff: asNonEmptyString(d.tradeOff),
      riskHypothesis: asNonEmptyString(d.riskHypothesis),
      reviewAt: asNonEmptyString(d.reviewAt)
    })).filter((d) => d.title),
    debts: asObjectArray(json.debts).map((d) => ({
      concept: asNonEmptyString(d.concept),
      context: asNonEmptyString(d.context),
      whyImportant: asNonEmptyString(d.whyImportant),
      nextQuestion: asNonEmptyString(d.nextQuestion)
    })).filter((d) => d.concept),
    themes: asObjectArray(json.themes).map((t) => ({
      name: asNonEmptyString(t.name),
      summary: asNonEmptyString(t.summary),
      representativeQuote: asNonEmptyString(t.representativeQuote),
      nextQuestion: asNonEmptyString(t.nextQuestion),
      maturity: asNonEmptyString(t.maturity)
    })).filter((t) => t.name),
    profileSuggestions: asObjectArray(json.profileSuggestions).map((p) => ({
      field: asNonEmptyString(p.field),
      suggestedValue: asNonEmptyString(p.suggestedValue),
      reason: asNonEmptyString(p.reason),
      evidenceQuote: asNonEmptyString(p.evidenceQuote)
    })).filter((p) => (p.field === "currentFocus" || p.field === "longTermGoal") && p.suggestedValue)
  };
}

function mapToFinalizeContent(
  parsed: ParsedFinalize,
  state: ProductState,
  session: InterviewSession,
  completedAt: string
): FinalizeContent {
  // Resolve theme ids up front so assets can link to them and so existing
  // themes (matched by name) keep their id through mergeFinalizedState.
  const themes: FinalizeThemeUpsert[] = parsed.themes.map((theme) => {
    const existing = state.themes.find((item) => item.name.trim() === theme.name.trim());
    return {
      id: existing?.id ?? makeId("theme"),
      name: theme.name,
      summary: theme.summary || theme.name,
      representativeQuote: theme.representativeQuote || parsed.keyQuote,
      nextQuestion: theme.nextQuestion || "下次值得就这个主题继续追问什么？",
      maturity: clampMaturity(theme.maturity)
    };
  });
  const themeIds = themes.map((theme) => theme.id as string);
  // Attribute an asset to the theme(s) whose name actually appears in its text, instead of
  // blanket-linking every asset to every theme of the session. Falls back to all themeIds
  // when nothing matches, so an asset is never orphaned (and Track stays populated).
  const attributeThemeIds = (text: string): string[] => {
    // 阈值提到 3:两字主题名(如"控制""成长")作为子串极易在无关文本里命中,造成假阳性归属。
    // ≥3 字才做子串归属;更短的名靠 fallback 兜底,不冒险误挂。
    const matched = themes
      .filter((theme) => theme.name.trim().length >= 3 && text.includes(theme.name.trim()))
      .map((theme) => theme.id as string);
    return matched.length ? matched : themeIds;
  };

  const note: DualTrackNote = {
    id: makeId("note"),
    sessionId: session.id,
    title: session.title,
    summary: parsed.summary,
    keyQuote: parsed.keyQuote,
    saidTrack: parsed.saidTrack,
    learnedTrack: parsed.learnedTrack,
    nextQuestions: parsed.nextQuestions,
    createdAt: completedAt
  };

  const points: PointAsset[] = parsed.points.map((point) => ({
    id: makeId("point"),
    title: point.title,
    content: point.content,
    status: "临时想法",
    confidence: "AI 推断",
    evidence: point.evidence.length ? point.evidence : [parsed.keyQuote],
    relatedThemeIds: attributeThemeIds(`${point.title} ${point.content}`),
    important: false,
    updatedAt: completedAt
  }));

  const questions: QuestionAsset[] = parsed.questions.map((question) => ({
    id: makeId("question"),
    question: question.question,
    whyImportant: question.whyImportant || "这个问题值得在后续专访中继续追问。",
    status: "正在聚焦",
    appearances: 1,
    relatedThemeIds: attributeThemeIds(`${question.question} ${question.whyImportant ?? ""}`),
    nextPrompt: question.nextPrompt || question.question,
    important: false,
    updatedAt: completedAt
  }));

  const decisions: DecisionAsset[] = parsed.decisions.map((decision) => ({
    id: makeId("decision"),
    title: decision.title,
    decisionKind: "候选决策",
    confirmationStatus: "待用户确认",
    choice: decision.choice || "（待用户补充具体选择）",
    tradeOff: decision.tradeOff || "（待补充取舍）",
    riskHypothesis: decision.riskHypothesis || "（待补充风险假设）",
    reviewAt: normalizeReviewAt(decision.reviewAt, completedAt),
    status: "待复盘",
    relatedThemeIds: attributeThemeIds(`${decision.title} ${decision.choice ?? ""}`),
    updatedAt: completedAt
  }));

  const debts: KnowledgeDebt[] = parsed.debts.map((debt) => ({
    id: makeId("debt"),
    concept: debt.concept,
    context: debt.context || "本次专访中出现，值得后续补全理解。",
    whyImportant: debt.whyImportant || "补全它有助于把模糊判断说清楚。",
    status: "待了解",
    nextQuestion: debt.nextQuestion || `你能用一个具体例子说明「${debt.concept}」吗？`,
    relatedThemeIds: attributeThemeIds(`${debt.concept} ${debt.context ?? ""}`),
    updatedAt: completedAt
  }));

  if (session.turns.filter((turn) => turn.role === "assistant").length === 0) {
    note.learnedTrack.push("本次没有形成足够的 AI 追问，应标记为轻量记录。");
  }

  const profileSuggestions = parsed.profileSuggestions.map((p) => ({
    field: p.field as ProfileSuggestionField,
    suggestedValue: p.suggestedValue,
    reason: p.reason,
    evidenceQuote: p.evidenceQuote || parsed.keyQuote
  }));

  return { note, points, questions, decisions, debts, themes, profileSuggestions };
}

// --- small, defensive coercion helpers ---

function stripCodeFences(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return (fenced ? fenced[1] : trimmed).trim();
}

function asNonEmptyString(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean);
}

function asObjectArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object");
}

function clampMaturity(value: string): LongTermTheme["maturity"] {
  // Unknown maturity falls back to 萌芽 (nascent), never a mid-ladder value — the upsert step
  // clamps it to the real appearance count anyway, but the floor should bias toward under-, not
  // over-stating how developed a theme is.
  return THEME_MATURITIES.includes(value as LongTermTheme["maturity"]) ? (value as LongTermTheme["maturity"]) : "萌芽";
}

function normalizeReviewAt(value: string, completedAt: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return value;
  }
  const base = new Date(completedAt);
  if (Number.isNaN(base.getTime())) {
    return completedAt.slice(0, 10);
  }
  base.setDate(base.getDate() + 30);
  return base.toISOString().slice(0, 10);
}

function pickLongestUserTurn(session: InterviewSession): string {
  return session.turns
    .filter((turn) => turn.role === "user")
    .map((turn) => turn.content)
    .sort((a, b) => b.length - a.length)[0] ?? "";
}
