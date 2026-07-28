// LLM-backed diary synthesis. Produces the dual-track note (双轨笔记) and
// long-term assets grounded in the ACTUAL conversation. Throws on any
// LLM/parse failure so the route exposes the error — /end fails loudly and
// the session stays open for retry; there is no deterministic substitute.
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
import type { BailianChatClient, BailianEmbeddingClient } from "../providers/bailian";
import { cosineSimilarity } from "../../../../src/domain/vector";

const THEME_MATURITIES: LongTermTheme["maturity"][] = ["萌芽", "重复", "聚焦", "成型", "变化", "关闭"];

const SYSTEM_PROMPT = [
  "你是一位资深专访编辑。一次专访结束后，你的任务是基于【真实对话内容】产出两样东西：",
  "1) 双轨笔记：轨道一「我说了什么」（用户的核心事件/判断/情绪/矛盾），轨道二「我学到了什么」（被挑战的假设、新视角、值得沉淀的问题）。",
  "2) 长期资产：观点、问题、决策、知识债、长期主题。",
  "铁律：只能基于用户真实说过的话，不许编造事实。keyQuote 和每条 evidence 必须是用户原话里的逐字片段。",
  "为每条资产标注它属于哪些主题（themeRefs）时，主题名必须逐字取自你本次输出的 themes[] 或已有主题线；拿不准就留空，不要臆造主题名。",
  "如果对话很浅、信息不足，就少产出资产（甚至只给 note），不要硬凑。",
  "只输出一个 JSON 对象，不要 Markdown、不要解释。"
].join("\n");

interface ParsedFinalize {
  summary: string;
  keyQuote: string;
  saidTrack: string[];
  learnedTrack: string[];
  nextQuestions: string[];
  // themeRefs: the theme NAMES the LLM says this asset belongs to. Grounded (not trusted blindly)
  // in mapToFinalizeContent against this finalize's themes[] ∪ existing state themes; unknown names
  // are dropped, an empty/absent list yields no attribution (no themes[0] fallback).
  points: Array<{ title: string; content: string; evidence: string[]; themeRefs: string[] }>;
  questions: Array<{ question: string; whyImportant: string; nextPrompt: string; themeRefs: string[] }>;
  decisions: Array<{ title: string; choice: string; tradeOff: string; riskHypothesis: string; reviewAt: string; evidence: string[]; themeRefs: string[] }>;
  debts: Array<{ concept: string; context: string; whyImportant: string; nextQuestion: string; evidence: string[]; themeRefs: string[] }>;
  themes: Array<{ name: string; summary: string; representativeQuote: string; nextQuestion: string; maturity: string }>;
  profileSuggestions: Array<{ field: string; suggestedValue: string; reason: string; evidenceQuote: string }>;
}

export async function finalizeSessionWithLlm(
  state: ProductState,
  session: InterviewSession,
  chatClient: BailianChatClient,
  providedCandidates?: MemoryCandidate[],
  embeddingClient?: BailianEmbeddingClient
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
    // truncates it mid-object → invalid JSON → the whole finalize fails loudly. 5000 gives
    // ample room (a full asset set is ~3000 tokens).
    maxTokens: 5000,
    // ...and generating that much over a dense 20K transcript takes well over the 60s default
    // for technical guests — which timed out → aborted → degrade. Allow up to 3 min.
    timeoutMs: 180000
  });

  const parsed = parseFinalizeJson(raw, session);
  const content = mapToFinalizeContent(parsed, state, session, completedAt);
  // 主题归属补全:LLM 在长 finalize JSON 里经常省略/留空 themeRefs(实测两次全空),且 point/theme
  // 字面不重叠(LLM 抽象命名,bigram 兜底失效,实测 best 仅 0.07~0.12)。用本地 embedding 做语义归属:
  // 把 relatedThemeIds 仍为空的资产挂到语义最近的本次主题,矛盾/演化②才有"同主题观点对"可判。
  await attributeThemesByEmbedding(content, embeddingClient);
  return mergeFinalizedState(state, session, content, completedAt, providedCandidates);
}

// 语义主题归属兜底(本地 embedding)。只补 relatedThemeIds 仍为空的资产,挂到本次 finalize 的 themes
// (同源最相关);相似度低于阈值则诚实留空。fail-safe:无 client / embed 失败 → 原样返回不阻塞归档。
async function attributeThemesByEmbedding(
  content: FinalizeContent,
  embeddingClient?: BailianEmbeddingClient
): Promise<void> {
  if (!embeddingClient || content.themes.length === 0) return;
  const themed = content.themes.filter(
    (t): t is FinalizeThemeUpsert & { id: string } => typeof t.id === "string" && t.id.length > 0
  );
  if (themed.length === 0) return;
  const assetText = (a: {
    title?: string; content?: string; choice?: string; concept?: string; context?: string; question?: string; whyImportant?: string;
  }) => [a.title, a.content, a.choice, a.concept, a.context, a.question, a.whyImportant].filter(Boolean).join("。");
  const targets: Array<{ asset: { relatedThemeIds?: string[] }; text: string }> = [];
  for (const p of content.points) if (!p.relatedThemeIds?.length) targets.push({ asset: p, text: assetText(p) });
  for (const d of content.decisions) if (!d.relatedThemeIds?.length) targets.push({ asset: d, text: assetText(d) });
  for (const d of content.debts) if (!d.relatedThemeIds?.length) targets.push({ asset: d, text: assetText(d) });
  for (const q of content.questions) if (!q.relatedThemeIds?.length) targets.push({ asset: q, text: assetText(q) });
  if (targets.length === 0) return;
  let themeVecs: number[][];
  let assetVecs: number[][];
  try {
    themeVecs = await embeddingClient.embed(themed.map((t) => `${t.name}。${t.summary ?? ""}`));
    assetVecs = await embeddingClient.embed(targets.map((t) => t.text));
  } catch (err) {
    console.warn(JSON.stringify({ event: "finalize_embed_attribution_failed", error: err instanceof Error ? err.message : String(err) }));
    return;
  }
  targets.forEach((t, i) => {
    const av = assetVecs[i];
    if (!av) return;
    let bestSim = -1;
    let bestId = "";
    themed.forEach((theme, j) => {
      const sim = cosineSimilarity(av, themeVecs[j]);
      if (sim > bestSim) { bestSim = sim; bestId = theme.id; }
    });
    // bge-large-zh 同主题语义相似度通常 >0.5;阈值 0.5 平衡召回与误挂。
    if (bestSim >= 0.5 && bestId) t.asset.relatedThemeIds = [bestId];
  });
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
    "【主题归属规则（themeRefs）】每条 points/questions/decisions/debts 都要标注它属于哪些长期主题：",
    "  · 取值来源【只有两个】：① 你本次在 themes[] 里产出的主题 name；② 上面【已有长期主题线】里列出的名称。两者都要【逐字一致】。",
    "  · 一条资产可属于 0、1 或多个主题；不确定它属于哪条主题，就给空数组 []——【宁可留空，绝不硬凑或臆造主题名】。",
    "  · 不要为了归属而新造一个没在 themes[] 里出现、也不在已有主题线里的名字（那样的名字会被直接丢弃）。",
    "",
    "请输出以下结构的 JSON（字段含义见注释，列表可为空数组）：",
    `{
  "summary": "一句话：这次对话真正把哪个问题推进到了哪一步（基于真实内容）",
  "keyQuote": "用户原话里最关键的一句，必须逐字摘录",
  "saidTrack": ["我说了什么：3-5 条，复述用户真实表达的核心"],
  "learnedTrack": ["我学到了什么：2-5 条，被挑战的假设/新视角/留待深挖的问题"],
  "nextQuestions": ["下次值得继续追问的问题，1-3 条"],
  "points": [{"title":"观点标题","content":"观点内容","evidence":["支撑这个观点的用户原话"],"themeRefs":["这条观点属于哪些主题：主题名必须逐字取自本次输出的 themes[] 的 name、或上面列出的已有主题线名称；拿不准就留空数组[]，绝不臆造或硬凑"]}],
  "questions": [{"question":"值得长期追的问题","whyImportant":"为什么重要","nextPrompt":"下次怎么问","themeRefs":["同上：本问题所属主题名，取自 themes[] 或已有主题线，拿不准留空[]"]}],
  "decisions": [{"title":"决策标题","choice":"用户倾向的选择","tradeOff":"取舍","riskHypothesis":"风险假设","reviewAt":"复盘日期YYYY-MM-DD，没有就留空","evidence":["支撑这个决策的用户原话，逐字摘录"],"themeRefs":["同上：本决策所属主题名，取自 themes[] 或已有主题线，拿不准留空[]"]}],
  "debts": [{"concept":"概念","context":"在本次对话中如何出现","whyImportant":"为什么值得补","nextQuestion":"下次的引导问题","evidence":["这个知识债在对话里冒出来时的用户原话，逐字摘录"],"themeRefs":["同上：本知识债所属主题名，取自 themes[] 或已有主题线，拿不准留空[]"]}],
  "themes": [{"name":"主题名：必须是能在别的对话里再次认出的【可复现主题】——一个反复出现的问题/张力/取舍，不要用一次性金句、比喻或诗意短语当名字","summary":"这条主题在追踪什么，以及下次靠什么线索能认出它又出现了","representativeQuote":"代表性原话","nextQuestion":"下次追问","maturity":"按它真实出现过几次填：只出现一次就是萌芽，不要凭单次对话的深度就标成型/聚焦"}],
  "profileSuggestions": [{"field":"currentFocus 或 longTermGoal","suggestedValue":"用户【当前关注】或【长期目标】的新表述——仅当本次对话清楚显示它相比下面【现有档案】发生了实质变化、或第一次被明确说清时才填；只是顺带提到、与现状一致、或只是一次性感慨，就把整个数组留空[]","reason":"为什么这是一个真实、稳定的变化，而不是一次性发言","evidenceQuote":"支撑这个判断的用户原话"}]
}`
  ]
    .filter(Boolean)
    .join("\n");
}

function parseFinalizeJson(raw: string, _session: InterviewSession): ParsedFinalize {
  const json = parseJsonObjectLoose(raw);
  if (!json) {
    throw new Error("finalize LLM returned unparseable JSON (possibly truncated at max_tokens)");
  }

  const summary = asNonEmptyString(json.summary);
  const saidTrack = asStringArray(json.saidTrack);
  const learnedTrack = asStringArray(json.learnedTrack);
  if (!summary || saidTrack.length === 0 || learnedTrack.length === 0) {
    throw new Error("LLM finalize output missing required note fields (summary/saidTrack/learnedTrack).");
  }

  // keyQuote 必须是 LLM 从对话里逐字摘的关键引用——缺了就是失败，
  // 绝不用"最长用户发言"启发式冒充。
  const keyQuote = asNonEmptyString(json.keyQuote);
  if (!keyQuote) {
    throw new Error("LLM finalize output has no keyQuote.");
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
      evidence: asStringArray(p.evidence),
      themeRefs: asStringArray(p.themeRefs)
    })).filter((p) => p.title && p.content),
    questions: asObjectArray(json.questions).map((q) => ({
      question: asNonEmptyString(q.question),
      whyImportant: asNonEmptyString(q.whyImportant),
      nextPrompt: asNonEmptyString(q.nextPrompt),
      themeRefs: asStringArray(q.themeRefs)
    })).filter((q) => q.question),
    decisions: asObjectArray(json.decisions).map((d) => ({
      title: asNonEmptyString(d.title),
      choice: asNonEmptyString(d.choice),
      tradeOff: asNonEmptyString(d.tradeOff),
      riskHypothesis: asNonEmptyString(d.riskHypothesis),
      reviewAt: asNonEmptyString(d.reviewAt),
      evidence: asStringArray(d.evidence),
      themeRefs: asStringArray(d.themeRefs)
    })).filter((d) => d.title),
    debts: asObjectArray(json.debts).map((d) => ({
      concept: asNonEmptyString(d.concept),
      context: asNonEmptyString(d.context),
      whyImportant: asNonEmptyString(d.whyImportant),
      nextQuestion: asNonEmptyString(d.nextQuestion),
      evidence: asStringArray(d.evidence),
      themeRefs: asStringArray(d.themeRefs)
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
  // 缺失的次级字段一律保持空——空表示"LLM 没产出"，绝不用罐头文案或 keyQuote 冒充。
  const themes: FinalizeThemeUpsert[] = parsed.themes.map((theme) => {
    const existing = state.themes.find((item) => item.name.trim() === theme.name.trim());
    return {
      id: existing?.id ?? makeId("theme"),
      name: theme.name,
      summary: theme.summary,
      representativeQuote: theme.representativeQuote,
      nextQuestion: theme.nextQuestion,
      maturity: clampMaturity(theme.maturity)
    };
  });
  // 受控主题归属(替代旧的 attributeThemeIds 子串猜):资产的 relatedThemeIds 由 LLM 在 finalize
  // 时直出的 themeRefs(主题名)解析而来。每个名字只能解析到「本次 content.themes(已 resolve id)
  // ∪ 历史 state.themes」里【同名】主题的 id;对不上的名字直接【忽略】(无幻觉,绝不创建新主题——
  // 主题只由 themes[] 产);themeRefs 为空 → 诚实留空 [],不再 fallback 到 themes[0]。
  // name→id 索引:本次主题优先(保证新主题/被合并的既有主题用本次解析出的同一 id),历史主题兜底
  // (让"延续既有主题但本次没在 themes[] 重列"的资产也能挂上)。
  const themeIdByName = new Map<string, string>();
  const themeIdByNorm = new Map<string, string>();
  // 归一化:去空白与中英标点、转小写。吸收 LLM 在 themes[].name 与各资产 themeRefs 两处命名的细微
  // 不一致(空格/标点/大小写)。否则精确匹配会大面积丢失主题归属 → relatedThemeIds 普遍为空 →
  // 矛盾/演化检测(欠账②)因无"同主题观点对"而完全失效(2026-06-29 真实业务 E2E 实测根因)。
  const normTheme = (s: string) =>
    s.trim().replace(/[\s「」《》“”‘’·,，。、:：;；!！?？()（）\-—_~～]/g, "").toLowerCase();
  const allThemesForRef = [
    ...state.themes.map((t) => ({ name: t.name, id: t.id })),
    ...themes.map((t) => ({ name: t.name, id: t.id }))
  ].filter((t): t is { name: string; id: string } => typeof t.id === "string" && t.id.length > 0);
  for (const theme of allThemesForRef) {
    themeIdByName.set(theme.name.trim(), theme.id);
    const nk = normTheme(theme.name);
    if (nk) themeIdByNorm.set(nk, theme.id);
  }
  const resolveThemeRefs = (themeRefs: string[]): string[] => {
    const ids: string[] = [];
    for (const ref of themeRefs) {
      // ① 精确 → ② 归一化精确 → ③ 归一化双向包含(唯一命中才采纳,避免把一个 ref 误挂到多主题)
      let id = themeIdByName.get(ref.trim()) ?? themeIdByNorm.get(normTheme(ref));
      if (!id) {
        const nr = normTheme(ref);
        if (nr.length >= 3) {
          const hits = allThemesForRef.filter((t) => {
            const nt = normTheme(t.name);
            return nt && (nt.includes(nr) || nr.includes(nt));
          });
          if (hits.length === 1) id = hits[0].id;
        }
      }
      if (id && !ids.includes(id)) ids.push(id);
      else if (!id && ref.trim())
        console.warn(JSON.stringify({ event: "finalize_themeref_unresolved", ref: ref.trim().slice(0, 24) }));
    }
    return ids;
  };

  // 注:字面 bigram 兜底已移除——实测对 LLM 抽象主题名无效(best 仅 0.07~0.12),且会违反"不靠子串
  // 共现臆造归属"的设计(误挂)。LLM 省略 themeRefs 时的归属改由 finalizeSessionWithLlm 末尾的
  // attributeThemesByEmbedding(本地 embedding 语义匹配)统一兜底,既准又不破坏 themeRefs 的受控语义。
  const resolveOrAttribute = (themeRefs: string[], _assetText: string): string[] => resolveThemeRefs(themeRefs);

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
    evidence: point.evidence,
    relatedThemeIds: resolveOrAttribute(point.themeRefs, `${point.title} ${point.content}`),
    important: false,
    updatedAt: completedAt
  }));

  const questions: QuestionAsset[] = parsed.questions.map((question) => ({
    id: makeId("question"),
    question: question.question,
    whyImportant: question.whyImportant,
    // 审计修复(P2-11):出生态统一为「开放」(与简报路径一致;此前 LLM 路硬编码「正在聚焦」造成
    // 出生口径分裂)。「正在聚焦」由 note-feedback 的用户动作晋升,「反复出现」由 upsert 复现晋升。
    status: "开放",
    appearances: 1,
    relatedThemeIds: resolveOrAttribute(question.themeRefs, `${question.question} ${question.whyImportant ?? ""}`),
    nextPrompt: question.nextPrompt,
    important: false,
    updatedAt: completedAt
  }));

  const decisions: DecisionAsset[] = parsed.decisions.map((decision) => ({
    id: makeId("decision"),
    title: decision.title,
    decisionKind: "候选决策",
    confirmationStatus: "待用户确认",
    choice: decision.choice,
    tradeOff: decision.tradeOff,
    riskHypothesis: decision.riskHypothesis,
    reviewAt: normalizeReviewAt(decision.reviewAt, completedAt),
    status: "待复盘",
    evidence: decision.evidence,
    relatedThemeIds: resolveOrAttribute(decision.themeRefs, `${decision.title} ${decision.choice ?? ""}`),
    updatedAt: completedAt
  }));

  const debts: KnowledgeDebt[] = parsed.debts.map((debt) => ({
    id: makeId("debt"),
    concept: debt.concept,
    context: debt.context,
    whyImportant: debt.whyImportant,
    status: "待了解",
    nextQuestion: debt.nextQuestion,
    evidence: debt.evidence,
    relatedThemeIds: resolveOrAttribute(debt.themeRefs, `${debt.concept} ${debt.context ?? ""}`),
    updatedAt: completedAt
  }));

  if (session.turns.filter((turn) => turn.role === "assistant").length === 0) {
    note.learnedTrack.push("本次没有形成足够的 AI 追问，应标记为轻量记录。");
  }

  const profileSuggestions = parsed.profileSuggestions.map((p) => ({
    field: p.field as ProfileSuggestionField,
    suggestedValue: p.suggestedValue,
    reason: p.reason,
    evidenceQuote: p.evidenceQuote
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

