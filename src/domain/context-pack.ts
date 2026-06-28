import type {
  InterviewCard,
  InterviewContextPack,
  InterviewGuide,
  InterviewGuideOptions,
  InterviewMode,
  InterviewResumeCard,
  InterviewSession,
  InterviewTurn,
  InterviewStrength,
  ImportSource,
  MemoryGraphReference,
  MemoryRecord,
  ProductState,
  RagChunk,
  SearchBrief,
  SearchBriefAgendaTrace,
  SourceHighlight,
  SystemConfig,
} from "./types";
import type { RecallResult } from "./recall";

import { cloneState, makeId, nowIso, withAuditEvent, withAiRunEvent, formatSearchTraceSourceLabel, getReferenceMaterialPublisher, daysBetween, modeLabels, removedExternalInstruction } from "./utils";

import { buildInterviewEnginePolicy } from "./strategy";
import { cosineSimilarity, topKByCosine } from "./vector";

// ponytail: 有界常量 — 上下文包中最多携带的 corrections 条数
const MAX_CONTEXT_CORRECTIONS = 20;

type SemanticRagContext = {
  chunks: RagChunk[];
  sourceHighlights: SourceHighlight[];
  importSources: ImportSource[];
};
export function addMemoryGraphToken(tokens: Set<string>, token: string) {
  const normalized = token.trim().toLowerCase();
  if (normalized.length < 2 || memoryGraphStopTokens.has(normalized)) {
    return;
  }
  tokens.add(normalized);
}
function buildBlindspotCandidates(missingPerspectives: string[], topicHint: string): InterviewGuide["blindspotCandidates"] {
  const blindspotByPerspective: Record<string, InterviewGuide["blindspotCandidates"][number]> = {
    "人类学": {
      concept: "团队惯性背后的组织文化",
      importance: "medium",
      reason: `当前话题“${topicHint}”容易只谈机制和个人责任，但还可以追问团队默认习惯是怎么被塑造的。`
    },
    "叙事": {
      concept: "用户在故事里扮演的角色",
      importance: "medium",
      reason: "用户在自己的故事里可能固定扮演了某个角色，值得追问：这是主动选择，还是被环境塑造的？"
    },
    "商业": {
      concept: "决策选择的业务代价",
      importance: "high",
      reason: "管理决策不能只停在理念层面，要落到时间、质量、客户和节奏上的具体代价。"
    },
    "形式科学": {
      concept: "可验证的判断标准",
      importance: "high",
      reason: "如果没有判断标准，放手只能变成情绪选择，无法被复盘。"
    }
  };
  const candidates = missingPerspectives
    .map((perspective) => blindspotByPerspective[perspective])
    .filter((item): item is InterviewGuide["blindspotCandidates"][number] => Boolean(item));
  return candidates.length > 0
    ? candidates.slice(0, 3)
    : [
        {
          concept: "短期失控的可承受边界",
          importance: "high",
          reason: "当前资产已覆盖多数常见视角，可以开始聚焦：你最担心的最坏情况，其可承受边界在哪里。"
        }
      ];
}
// M1: memory→theme graph references now project from record.relatedThemeIds (the
// unified embedded soft-link that replaced state.memoryEdges). Same topic-token gate +
// 16-link cap as before, then dedup by theme into MemoryGraphReference[]. Iteration is
// record-then-theme so the cap counts contributing (record, theme) pairs identically to
// the old edge list (which was record-keyed too).
function buildMemoryGraphReferences(
  state: ProductState,
  memoryRecords: MemoryRecord[],
  topicHint: string
): MemoryGraphReference[] {
  const topicTokens = tokenizeMemoryGraphText(topicHint);
  const themesById = new Map(state.themes.map((t) => [t.id, t]));
  const seenThemes = new Set<string>();
  const references: MemoryGraphReference[] = [];
  let kept = 0;
  for (const record of memoryRecords) {
    for (const themeId of record.relatedThemeIds ?? []) {
      const theme = themesById.get(themeId);
      if (!theme) {
        continue;
      }
      if (topicTokens.size > 0) {
        const edgeTokens = tokenizeMemoryGraphText(
          [record.text, record.evidenceQuote, theme.name, theme.summary].filter(Boolean).join(" ")
        );
        if (!hasMemoryGraphTokenOverlap(topicTokens, edgeTokens)) {
          continue;
        }
      }
      // 16-link cap mirrors the legacy memoryEdges.slice(0, 16) on the filtered set.
      if (kept >= 16) {
        return references;
      }
      kept += 1;
      if (!seenThemes.has(theme.id)) {
        seenThemes.add(theme.id);
        references.push({ themeId: theme.id, themeLabel: theme.name });
      }
    }
  }
  return references;
}
function buildContextSecurityInterceptions(
  state: ProductState,
  topicHint: string,
  memoryPolicy: SystemConfig["memory"],
  externalContext: {
    searchBrief?: SearchBrief;
    ragChunks: RagChunk[];
  }
): InterviewContextPack["securityInterceptions"] {
  const topicTokens = tokenizeMemoryGraphText(topicHint);
  const isRelevant = (text: string) => topicTokens.size === 0 || hasMemoryGraphTokenOverlap(topicTokens, tokenizeMemoryGraphText(text));
  const interceptions: InterviewContextPack["securityInterceptions"] = [];

  for (const record of state.memoryRecords) {
    const corpus = [record.text, record.evidenceQuote, record.deprecatedReason].filter(Boolean).join(" ");
    if (!isRelevant(corpus)) {
      continue;
    }
    if (record.status !== "confirmed") {
      interceptions.push({
        kind: "unsafe_memory_status_excluded",
        sourceType: "memory_record",
        sourceId: record.id,
        label: formatMemoryGraphTargetLabel(record.text),
        reason: `长期记忆状态为 ${record.status}，不能默认召回到模型上下文。${record.deprecatedReason ?? ""}`.trim(),
        severity: "critical"
      });
      continue;
    }
    if (!memoryPolicy.includeSensitiveMemoriesInContext && !isModelSafeMemoryRecord(record)) {
      interceptions.push({
        kind: "sensitive_memory_excluded",
        sourceType: "memory_record",
        sourceId: record.id,
        label: formatMemoryGraphTargetLabel(record.text),
        reason: "敏感长期记忆默认不进入专访模型上下文，需要用户在配置中显式开启。",
        severity: "warning"
      });
    }
  }

  if (memoryPolicy.includePendingCandidatesInContext && !memoryPolicy.includeSensitiveMemoriesInContext) {
    for (const candidate of state.memoryCandidates) {
      if (
        candidate.status !== "pending" ||
        candidate.sensitivity !== "sensitive" ||
        !isRelevant([candidate.text, candidate.evidenceQuote, candidate.reason].join(" "))
      ) {
        continue;
      }
      interceptions.push({
        kind: "sensitive_candidate_excluded",
        sourceType: "memory_candidate",
        sourceId: candidate.id,
        label: formatMemoryGraphTargetLabel(candidate.text),
        reason: "敏感待审候选默认不进入专访模型上下文，需要先经过用户确认和显式配置。",
        severity: "warning"
      });
    }
  }

  if (externalContext.searchBrief && searchBriefHasRemovedExternalInstruction(externalContext.searchBrief)) {
    interceptions.push({
      kind: "external_instruction_removed",
      sourceType: "search_brief",
      sourceId: externalContext.searchBrief.id,
      label: externalContext.searchBrief.topic,
      reason: "外部搜索素材包含疑似 prompt injection 指令，已作为 quoted source 清洗后再进入模型上下文。",
      severity: "critical"
    });
  }

  for (const chunk of externalContext.ragChunks) {
    if (!chunk.text.includes(removedExternalInstruction)) {
      continue;
    }
    interceptions.push({
      kind: "external_instruction_removed",
      sourceType: "rag_chunk",
      sourceId: chunk.id,
      label: chunk.title,
      reason: "导入资料片段包含疑似 prompt injection 指令，已清洗为引用材料而非系统指令。",
      severity: "critical"
    });
  }

  return interceptions;
}
export function buildInterviewCard(state: ProductState, searchBriefId?: string, topicHint?: string, queryEmbedding?: number[], recall?: RecallResult, prebuiltGuide?: InterviewGuide): InterviewCard {
  const topTheme = [...state.themes].sort((a, b) => b.appearances - a.appearances)[0];
  const themeName = topTheme?.name ?? "当前问题";
  const openDebt = state.debts.find((debt) => debt.status === "待了解") ?? state.debts[0];
  const confirmedMemoryTexts = collectConfirmedMemoryTexts(state);
  const reference = topTheme?.representativeQuote ?? confirmedMemoryTexts[0] ?? "你最近有一个反复出现的问题。";
  const explicitTopicHint = topicHint?.trim();
  const contextOptions = {
    ...(searchBriefId ? { searchBriefId } : {}),
    ...(explicitTopicHint ? { topicHint: explicitTopicHint } : {}),
    ...(queryEmbedding ? { queryEmbedding } : {})
  };
  const searchBrief = resolveInterviewContextSearchBrief(state, contextOptions);
  const contextPack = buildInterviewContextPack(state, contextOptions, recall);
  const contextSourceHighlights = contextPack.sourceHighlights.slice(0, 3);
  const focusQuestion = searchBrief || explicitTopicHint ? undefined : findNextInterviewFocusQuestion(state);
  const title = explicitTopicHint
    ? `继续追问：${formatQuestionTitle(explicitTopicHint)}`
    : focusQuestion
    ? `继续追问：${formatQuestionTitle(focusQuestion.question)}`
    : topTheme
      ? `关于「${topTheme.name}」的专访`
      : "今天想聊点什么？";
  const sourceReferences = searchBrief
    ? [
        `联网素材/外部资料（来源：${getPrimarySearchSourceLabel(searchBrief)}）：${searchBrief.summary}`,
        ...searchBrief.sources.slice(0, 2).map((source) => `来源：${source.publisher}：${source.title}`)
      ]
    : contextPack.ragChunks
        .slice(0, 2)
        .map((chunk) => `导入资料（来源：${formatRagChunkSourceLabel(state, chunk)}）：${chunk.text}`);
  const hasContextSources = contextSourceHighlights.length > 0;
  // M4:复用上游(createSessionDraft)已 build 的 guide,避免 session 创建路径重复 build guide
  //（含 buildInterviewContextPack + buildPerspectiveCoverage 全语料 × signal 的热点);前端/独立调用不传则自行 build。
  const guide = prebuiltGuide ?? buildInterviewGuide(state, contextOptions, recall);
  // P2b:溯源原话(surreal 权威召回带回时)纳入历史参照,让 LLM 能引用受访者原话佐证观点。
  const evidenceQuotes = (contextPack.provenanceTurns ?? [])
    .flatMap((entry) => entry.turns.map((t) => `证据原话（${entry.assetTable}）：${t.content}`))
    .slice(0, 2);
  const agendaContext = searchBrief?.agendaTrace ? formatSearchAgendaTraceForInterview(searchBrief.agendaTrace) : undefined;
  const neutralTension = topTheme?.nextQuestion ?? "（暂无明显张力，先自由展开。）";

  return {
    title,
    whyNow: searchBrief
      ? agendaContext
        ? `你最近多次提到${themeName}，同时”${searchBrief.topic}”出现了可借用的外部素材。${agendaContext}，适合把个人问题放进更大的语境里看。`
        : `你最近多次提到${themeName}，同时”${searchBrief.topic}”出现了可借用的外部素材，适合把个人问题放进更大的语境里看。`
      : explicitTopicHint && hasContextSources
        ? `你刚选中的线索命中了可引用的导入资料，适合先借外部材料校准问题，再回到你的具体场景。`
      : explicitTopicHint
        ? `你刚在资产库中选中了这条线索，适合直接接上它继续专访，而不是回到泛泛复盘。`
        : focusQuestion
          ? `你在会后反馈里明确要求继续追问这个问题，适合直接接上上次的未完成线索。`
          : topTheme
            ? topTheme.summary
              ? `你最近多次提到${topTheme.name}：${topTheme.summary}`
              : `你最近多次提到${topTheme.name}，但还没有把”最坏会发生什么”说具体。`
            : "从你最近的一段记录继续，或聊聊此刻最在意的事。",
    suggestedOpening: searchBrief
      ? `我们先从一个外部素材切入：${ensureSentenceEnd(explicitTopicHint ?? searchBrief.discussionTopics[0])}它和你最近的真实场景有什么关系？`
      : explicitTopicHint && hasContextSources
        ? `我们先拿这条导入资料做参照：${ensureSentenceEnd(explicitTopicHint)}它和你最近的真实场景有什么关系？`
        : guide.suggestedOpening,
    historyReferences: Array.from(new Set([...(agendaContext ? [agendaContext] : []), ...sourceReferences, reference, ...evidenceQuotes, ...confirmedMemoryTexts])).slice(0, 4),
    potentialTension: searchBrief?.sourceAngles[0] ?? contextPack.ragChunks[0]?.text ?? neutralTension,
    suggestedPerspectives: guide.recommendedPerspectives,
    likelyOutputs: [
      "一个更准确的长期问题",
      openDebt ? `知识债回访：${openDebt.concept}` : "一个新的知识债候选",
      topTheme ? `关于「${topTheme.name}」的新观点` : "一条可沉淀的观察",
      ...(hasContextSources ? [`素材引用：${contextSourceHighlights[0]?.title}`] : [])
    ],
    searchBriefId: searchBrief?.id,
    sourceHighlights: hasContextSources ? contextSourceHighlights : undefined,
    // ②:把"系统发现的观点演化/对立观点"带进 card,让采访 UI 可触达(此前只在 LLM prompt 隐式)。
    opinionEvolution: buildOpinionEvolution(state),
    contradictions: buildPointContradictions(state)
  };
}

export interface CreateSessionOptions {
  searchBriefId?: string;
  topicHint?: string;
  /** M3c: route-computed query vector for semantic memory recall at session creation. */
  queryEmbedding?: number[];
  /** P2b:server 预召回数据;前端/sqlite 不传,走域层回落。 */
  recall?: RecallResult;
}

export function buildInterviewContextPack(state: ProductState, options: InterviewGuideOptions = {}, recall?: RecallResult): InterviewContextPack {
  const topicHint = resolveInterviewTopicHint(state, options);
  const memoryPolicy = state.systemConfig.memory;
  const contextSourceLimit = Math.max(1, state.systemConfig.search.maxSources);
  const sourceHighlightLimit = Math.max(0, state.systemConfig.search.maxSources);
  const searchBrief = resolveInterviewContextSearchBrief(state, options);
  const searchSourceHighlights = searchBrief?.sources.slice(0, sourceHighlightLimit) ?? [];
  const linkedImportSource = searchBrief ? state.importSources.find((source) => source.searchBriefId === searchBrief.id) : undefined;
  const linkedRagChunks = linkedImportSource
    ? state.ragChunks
        .filter((chunk) => linkedImportSource.chunkIds.includes(chunk.id))
        .slice(0, contextSourceLimit)
    : [];
  // M3c: 路由层有 embeddingClient 时会算出 queryEmbedding 并穿入，导入资料语义召回走 cosine；
  // 无 embeddingClient 时回退到关键词召回（topicHint 较短，关键词足够）。专用资料问答端点
  // POST /api/rag/query 走同一条 buildSemanticRagContext cosine 路径。
  const semanticRagContext = linkedImportSource
    ? emptySemanticRagContext()
    : buildSemanticRagContext(state, topicHint, contextSourceLimit, options.queryEmbedding);
  const ragChunks = linkedImportSource ? linkedRagChunks : semanticRagContext.chunks;
  const sourceHighlights = [...searchSourceHighlights, ...semanticRagContext.sourceHighlights].slice(0, sourceHighlightLimit);
  const activeRecords = state.memoryRecords.filter(
    (record) =>
      record.status === "confirmed" &&
      (memoryPolicy.includeSensitiveMemoriesInContext || isModelSafeMemoryRecord(record))
  );
  // M4: single source of truth for long-term memory is memoryRecords only (the legacy
  // profile.confirmedMemories/inferredMemories parallel store has since been removed).
  const memoryRecords = [...activeRecords];
  // M3c: when the route supplied a queryEmbedding, rank confirmed memories by the
  // three-factor scorer (cosine relevance + recency + importance) so the context
  // pack mirrors the same semantic recall as guide.relevantMemories. Without it,
  // fall back to the substring ranking (unchanged behaviour).
  // P2b:有 recall.memoryHits(向量 HNSW 召回)→ 候选 record 三因子精排;否则现状(queryEmbedding 走语义,无则子串)。
  const confirmedMemories = recall?.memoryHits
    ? rankMemoryRecordsBySemantics(
        // P2b:与 collectRelevantMemories 的记忆池口径统一 —— memoryHits ∪ themeAssets.memories(图主题记忆)。
        (() => { const ids = new Set([...recall.memoryHits.map((h) => h.id), ...(recall.themeAssets?.memories ?? [])]); return memoryRecords.filter((record) => ids.has(record.id)); })(),
        topicHint,
        options.queryEmbedding ?? []
      )
    : options.queryEmbedding
      ? rankMemoryRecordsBySemantics(memoryRecords, topicHint, options.queryEmbedding)
      : rankMemoryTexts(memoryRecords.map((record) => record.text), topicHint);
  const graphReferences = buildMemoryGraphReferences(state, memoryRecords, topicHint);
  const pendingCandidates = memoryPolicy.includePendingCandidatesInContext
    ? state.memoryCandidates.filter(
        (candidate) =>
          candidate.status === "pending" &&
          (memoryPolicy.includeSensitiveMemoriesInContext || candidate.sensitivity !== "sensitive")
      )
    : [];
  const securityInterceptions = buildContextSecurityInterceptions(state, topicHint, memoryPolicy, {
    searchBrief,
    ragChunks
  });

  return {
    topicHint,
    confirmedMemories,
    memoryRecords,
    pendingCandidates,
    // ponytail: 有界,防无界直传 — 只取最近 MAX_CONTEXT_CORRECTIONS 条
    corrections: [...state.memoryCorrections]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, MAX_CONTEXT_CORRECTIONS),
    graphReferences,
    ...(recall?.provenance ? { provenanceTurns: recall.provenance } : {}),
    searchBriefs: searchBrief ? [searchBrief] : [],
    sourceHighlights,
    ragChunks,
    securityInterceptions,
    sources: [
      ...memoryRecords.map((record) => ({
        id: record.id,
        type: record.sourceType,
        label:
          record.sourceType === "profile"
            ? "用户确认档案"
            : record.sourceType === "interview_session"
              ? "专访沉淀"
              : record.sourceType === "search_brief"
                ? "联网素材候选"
                : record.sourceType === "corpus_import"
                  ? "语料学习候选"
                  : "长期记忆"
      })),
      ...(searchBrief
        ? [
            {
              id: searchBrief.id,
              type: "search_brief" as const,
              label: `联网素材：${searchBrief.topic}`
            }
          ]
        : []),
      ...(linkedImportSource
        ? [
            {
              id: linkedImportSource.id,
              type: "import_source" as const,
              label: `导入资料：${linkedImportSource.title}`
            }
          ]
        : []),
      ...semanticRagContext.importSources.map((source) => ({
        id: source.id,
        type: "import_source" as const,
        label: `导入资料语义召回：${source.title}`
      }))
    ]
  };
}
/**
 * P2b:解析驱动召回的当前主题。抽出 buildInterviewGuide 原 topicHint 表达式,使 server 预召回
 * 与域内召回用同一主题(DRY + 一致)。纯函数,无副作用。
 */
export function resolveInterviewTopicHint(state: ProductState, options: InterviewGuideOptions = {}): string {
  const explicitTopicHint = options.topicHint?.trim();
  const searchBrief = resolveInterviewContextSearchBrief(state, options);
  const topTheme = [...state.themes].sort((a, b) => b.appearances - a.appearances)[0];
  const focusQuestion = searchBrief || explicitTopicHint ? undefined : findNextInterviewFocusQuestion(state);
  return explicitTopicHint || searchBrief?.topic || focusQuestion?.question || topTheme?.name || state.profile.currentFocus;
}
export function buildInterviewGuide(state: ProductState, options: InterviewGuideOptions = {}, recall?: RecallResult): InterviewGuide {
  const explicitTopicHint = options.topicHint?.trim();
  const searchBrief = resolveInterviewContextSearchBrief(state, options);
  const topTheme = [...state.themes].sort((a, b) => b.appearances - a.appearances)[0];
  const focusQuestion = searchBrief || explicitTopicHint ? undefined : findNextInterviewFocusQuestion(state);
  const openDebts = state.debts
    .filter((debt) => debt.status === "待了解")
    .map((debt) => ({
      concept: debt.concept,
      context: debt.context,
      daysOpen: daysBetween(debt.updatedAt, nowIso()),
      nextQuestion: debt.nextQuestion
    }));
  const debtToAddress = openDebts[0]?.concept;
  const topicHint = resolveInterviewTopicHint(state, options);
  const contextPack = buildInterviewContextPack(state, {
    topicHint,
    ...(options.searchBriefId ? { searchBriefId: options.searchBriefId } : {}),
    ...(options.queryEmbedding ? { queryEmbedding: options.queryEmbedding } : {})
  }, recall);
  const perspectiveCoverage = buildPerspectiveCoverage(state);
  const missingPerspectives = defaultPerspectiveOrder.filter((perspective) => perspectiveCoverage[perspective] === 0);
  const recommendedPerspectives = chooseRecommendedPerspectives(topicHint, searchBrief, perspectiveCoverage, missingPerspectives);
  // M3b: now 由编排层注入纯函数评分器，scoreMemoryForRetrieval 自身不触碰时钟。
  // M3c: 路由层有 embeddingClient 时会算出 queryEmbedding 并穿入，relevantMemories 走 cosine；
  // 无 embeddingClient（或记忆无 embedding）时回退到子串命中率，行为与旧逻辑一致。
  const relevantMemories = collectRelevantMemories(
    state,
    topicHint,
    contextPack,
    options.queryEmbedding,
    nowIso(),
    recall
  );
  const statedPositions = state.points.slice(0, 4).map((point) => `${point.title}：${point.content}`);
  const openingQuestion = searchBrief
    ? explicitTopicHint
      ? `我们先拿这条联网讨论主题做外部参照：${ensureSentenceEnd(explicitTopicHint)}它和你最近反复说的“${topTheme?.name ?? "这个问题"}”有什么真实关系？`
      : `我们先拿“${searchBrief.topic}”做外部参照：它和你最近反复说的“${topTheme?.name ?? "这个问题"}”有什么真实关系？`
    : explicitTopicHint
      ? `我们从你选中的资产继续：${ensureSentenceEnd(explicitTopicHint)}先讲一个最具体的场景。`
      : focusQuestion
        ? `${focusQuestion.question} 先从你上次明确要求继续的地方开始：${focusQuestion.nextPrompt}`
        : topTheme?.nextQuestion ?? "今天先从一个最近反复出现的问题讲起：它具体发生在哪个场景里？";
  const agendaContext = searchBrief?.agendaTrace ? formatSearchAgendaTraceForInterview(searchBrief.agendaTrace) : undefined;

  return {
    topicHint,
    dailyBrief: {
      suggestedTopic: topicHint,
      openingQuestion,
      contextNote: searchBrief
        ? agendaContext
          ? `本次会把联网素材作为参照；${agendaContext}；但必须回到用户自己的具体事件。`
          : `本次会把联网素材作为参照，但必须回到用户自己的具体事件。`
        : explicitTopicHint
          ? `本次从用户在资产库中选中的主题继续追问。`
          : focusQuestion
            ? `本次优先接上用户会后反馈中标记为“值得下次继续”的问题。`
            : `本次优先回访长期主题“${topTheme?.name ?? "未命名主题"}”和未完成知识债。`
    },
    perspectiveCoverage,
    missingPerspectives,
    recommendedPerspectives,
    perspectiveRationale: buildPerspectiveRationale(recommendedPerspectives, missingPerspectives, searchBrief),
    relevantMemories,
    graphReferences: contextPack.graphReferences,
    opinionEvolution: buildOpinionEvolution(state),
    statedPositions,
    openDebts,
    debtToAddress,
    blindspotCandidates: buildBlindspotCandidates(missingPerspectives, topicHint),
    knowledgeFragments: buildKnowledgeFragments(state, searchBrief, contextPack.ragChunks),
    suggestedOpening: openingQuestion,
    strategyChecklist: buildStrategyChecklist(state, {
      openingQuestion,
      debtToAddress,
      recommendedPerspectives,
      agendaContext
    })
  };
}
export function buildInterviewResumeCard(state: ProductState): InterviewResumeCard | null {
  const activeSession = [...state.sessions]
    .filter((item) => item.status === "active")
    .sort((a, b) => Date.parse(getSessionLastUpdatedAt(b)) - Date.parse(getSessionLastUpdatedAt(a)))[0];

  if (!activeSession) {
    return null;
  }

  const lastUserTurn = findLastTurn(activeSession, "user");
  const lastAssistantTurn = findLastTurn(activeSession, "assistant");
  const lastDecision = activeSession.strategyTrace?.at(-1);
  const userTurns = activeSession.turns.filter((turn) => turn.role === "user");
  const alreadyClarified =
    userTurns.length > 0
      ? userTurns.slice(-3).map((turn) => turn.content)
      : [`还没有留下表达，本次准备从“${activeSession.card.suggestedOpening}”开始。`];

  return {
    sessionId: activeSession.id,
    title: activeSession.title,
    mode: activeSession.mode,
    currentTopic: activeSession.guide.topicHint || activeSession.card.title,
    startedAt: activeSession.startedAt,
    lastUpdatedAt: getSessionLastUpdatedAt(activeSession),
    lastUserQuote: lastUserTurn?.content ?? "还没有留下表达",
    pendingQuestion: lastAssistantTurn?.content ?? activeSession.card.suggestedOpening,
    nextClue:
      lastDecision?.reason ??
      activeSession.guide.strategyChecklist.find((item) => item.includes("知识债")) ??
      activeSession.card.potentialTension,
    alreadyClarified,
    turnCount: userTurns.length
  };
}
function buildKnowledgeFragments(state: ProductState, searchBrief: SearchBrief | undefined, ragChunks: RagChunk[] = []) {
  const fromSearch = searchBrief
    ? [
        ...searchBrief.facts.slice(0, 2).map((fact) => formatExternalMaterial("外部资料", searchBrief, fact)),
        ...searchBrief.controversies.slice(0, 1).map((view) => formatExternalMaterial("外部观点", searchBrief, view)),
        ...searchBrief.opposingViews.slice(0, 1).map((view) => formatExternalMaterial("外部观点", searchBrief, view))
      ]
    : [];
  const fromRagChunks = ragChunks.slice(0, 2).map((chunk) => `导入资料片段：${chunk.text}`);
  const fromDebts = state.debts.slice(0, 2).map((debt) => `${debt.concept}：${debt.whyImportant}`);
  const fromPatches = state.playbookPatches
    .filter((patch) => patch.status === "applied")
    .flatMap((patch) => patch.rules.slice(0, 2));
  return [...fromSearch, ...fromRagChunks, ...fromDebts, ...fromPatches].slice(0, 6);
}
// M1: compute the theme ids a memory record belongs to (token≥2 overlap with each
// theme's text). Replaces buildMemoryEdgesForRecord — returns plain theme ids that the
// caller merges into record.relatedThemeIds, instead of minting MemoryEdge objects.
// Computes from scratch over all themes; dedup/preservation is the caller's concern.
export function computeRecordThemeIds(state: ProductState, record: MemoryRecord): string[] {
  const sourceTokens = tokenizeMemoryGraphText(`${record.text} ${record.evidenceQuote}`);
  if (sourceTokens.size === 0) {
    return [];
  }

  return state.themes
    .map((theme) => {
      const themeTokens = tokenizeMemoryGraphText(
        [theme.name, theme.summary, theme.representativeQuote, theme.nextQuestion].join(" ")
      );
      const sharedCount = Array.from(sourceTokens).filter((t) => themeTokens.has(t)).length;
      return { theme, sharedCount };
    })
    .filter(({ sharedCount }) => sharedCount >= 2)
    .map(({ theme }) => theme.id);
}
// 轻量推理(欠账②)做实:观点演化从 point 的 supersededByPointId 链产生真实条目,
// 不再用 notes[0]+points[0] 假拼。每条 = (被取代观点 → 取代观点):
//   oldView = 旧 point.content;newView = 取代方 point.content;
//   topic   = 两者共同主题名(relatedThemeIds 交集 → theme.name),无共同主题则回退到任一方主题/通用文案;
//   date    = 取代方 updatedAt(演化发生时间)。
// 无任何 supersededBy 关系 → 返回 [](诚实空,而非假造一条)。
/** ②:从 points 的 contradictsPointIds 派生对立观点对(symmetric 去重、字典序),供 card/UI 呈现。 */
export function buildPointContradictions(state: ProductState): Array<{ a: string; b: string }> {
  const byId = new Map(state.points.map((p) => [p.id, p] as const));
  const seen = new Set<string>();
  const out: Array<{ a: string; b: string }> = [];
  for (const p of state.points) {
    for (const otherId of p.contradictsPointIds ?? []) {
      const key = p.id < otherId ? `${p.id}|${otherId}` : `${otherId}|${p.id}`;
      if (seen.has(key)) continue;
      const other = byId.get(otherId);
      if (!other) continue;
      seen.add(key);
      const [lo, hi] = p.id < otherId ? [p, other] : [other, p];
      out.push({ a: lo.title, b: hi.title });
    }
  }
  return out.slice(0, 5);
}

export function buildOpinionEvolution(state: ProductState): InterviewGuide["opinionEvolution"] {
  const pointById = new Map(state.points.map((p) => [p.id, p] as const));
  const themeNameById = new Map(state.themes.map((t) => [t.id, t.name] as const));

  const evolution: InterviewGuide["opinionEvolution"] = [];
  for (const oldP of state.points) {
    if (!oldP.supersededByPointId) continue;
    const newP = pointById.get(oldP.supersededByPointId);
    if (!newP) continue; // 取代方不存在(被删/悬挂)→ 跳过,不产空壳条目

    evolution.push({
      topic: resolveEvolutionTopic(oldP.relatedThemeIds, newP.relatedThemeIds, themeNameById),
      oldView: oldP.content,
      newView: newP.content,
      date: newP.updatedAt
    });
  }
  return evolution;
}

// 共同主题名:先取两观点 relatedThemeIds 的交集→主题名;无交集则取任一方第一个有名字的主题;
// 都没有则通用文案。纯查表,不臆造。
function resolveEvolutionTopic(
  oldThemeIds: string[] | undefined,
  newThemeIds: string[] | undefined,
  themeNameById: Map<string, string>
): string {
  const olds = oldThemeIds ?? [];
  const news = newThemeIds ?? [];
  const shared = olds.find((id) => news.includes(id) && themeNameById.has(id));
  if (shared) return themeNameById.get(shared)!;
  for (const id of [...olds, ...news]) {
    const name = themeNameById.get(id);
    if (name) return name;
  }
  return "长期主题";
}
function buildPerspectiveCoverage(state: ProductState): Record<string, number> {
  const corpus = [
    state.profile.currentFocus,
    state.profile.longTermGoal,
    ...collectConfirmedMemoryTexts(state),
    ...state.notes.flatMap((note) => [note.title, note.summary, note.keyQuote, ...note.saidTrack, ...note.learnedTrack]),
    ...state.points.flatMap((point) => [point.title, point.content, ...point.evidence]),
    ...state.questions.flatMap((question) => [question.question, question.whyImportant, question.nextPrompt]),
    ...state.decisions.flatMap((decision) => [decision.title, decision.choice, decision.tradeOff, decision.riskHypothesis]),
    ...state.debts.flatMap((debt) => [debt.concept, debt.context, debt.whyImportant, debt.nextQuestion]),
    ...state.themes.flatMap((theme) => [theme.name, theme.summary, theme.representativeQuote, theme.nextQuestion]),
    ...state.sessions.flatMap((session) => [
      session.title,
      session.card.title,
      ...session.card.suggestedPerspectives,
      ...session.turns.map((turn) => turn.content)
    ])
  ].join(" ");

  return Object.fromEntries(
    defaultPerspectiveOrder.map((perspective) => [
      perspective,
      perspectiveSignals[perspective].reduce((count, signal) => count + countOccurrences(corpus, signal), 0)
    ])
  );
}
function buildPerspectiveRationale(
  recommendedPerspectives: string[],
  missingPerspectives: string[],
  searchBrief: SearchBrief | undefined
) {
  const missingNote =
    missingPerspectives.length > 0
      ? `历史资产较少覆盖 ${missingPerspectives.slice(0, 2).join(" / ")}，本轮需要补视角。`
      : "历史资产已有多视角覆盖，本轮重点做交叉验证。";
  const sourceNote = searchBrief ? `同时接入“${searchBrief.topic}”的外部素材，避免只在个人经验内循环。` : "";
  return `推荐 ${recommendedPerspectives.join(" / ")}：${missingNote}${sourceNote}`;
}
export function buildSemanticRagContext(
  state: ProductState,
  topicHint: string,
  limit: number,
  queryEmbedding?: number[]
): SemanticRagContext {
  if (state.ragChunks.length === 0) {
    return emptySemanticRagContext();
  }

  const sourcesById = new Map(state.importSources.map((source) => [source.id, source]));

  // Eligible candidates: correct usage + source allowed in context
  const candidates = state.ragChunks
    .map((chunk) => {
      const source = sourcesById.get(chunk.sourceId);
      if (!source || chunk.usage !== "interview-context" || !isImportSourceAllowedInContext(source, state.systemConfig.memory)) {
        return undefined;
      }
      return { chunk, source };
    })
    .filter((item): item is { chunk: RagChunk; source: ImportSource } => Boolean(item));

  // Cosine path: queryEmbedding present AND at least one candidate has an embedding
  const hasEmbeddedChunks = candidates.some((item) => Array.isArray(item.chunk.embedding));
  if (queryEmbedding && hasEmbeddedChunks) {
    const embeddedCandidates = candidates.filter(
      (item): item is { chunk: RagChunk & { embedding: number[] }; source: ImportSource } =>
        Array.isArray(item.chunk.embedding)
    );
    const topChunks = topKByCosine(queryEmbedding, embeddedCandidates.map((item) => item.chunk), limit);
    const topChunkIds = new Set(topChunks.map((c) => c.id));
    const matches = embeddedCandidates.filter((item) => topChunkIds.has(item.chunk.id));
    // Restore cosine-sorted order
    matches.sort((a, b) => topChunks.findIndex((c) => c.id === a.chunk.id) - topChunks.findIndex((c) => c.id === b.chunk.id));

    const importSources = Array.from(new Map(matches.map((match) => [match.source.id, match.source])).values());
    return {
      chunks: matches.map((match) => match.chunk),
      sourceHighlights: matches.map((match, index) => buildSemanticRagSourceHighlight(match.source, match.chunk, 10 - index, index)),
      importSources
    };
  }

  // Keyword fallback path (original behaviour, fully preserved)
  const topicTokens = tokenizeMemoryGraphText(topicHint);
  if (topicTokens.size === 0) {
    return emptySemanticRagContext();
  }

  const matches = candidates
    .map((item) => ({
      chunk: item.chunk,
      source: item.source,
      score: scoreRagChunkForTopic(item.chunk, item.source, topicTokens)
    }))
    .filter((match) => match.score >= 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  const importSources = Array.from(new Map(matches.map((match) => [match.source.id, match.source])).values());

  return {
    chunks: matches.map((match) => match.chunk),
    sourceHighlights: matches.map((match, index) => buildSemanticRagSourceHighlight(match.source, match.chunk, match.score, index)),
    importSources
  };
}
function buildSemanticRagSourceHighlight(source: ImportSource, chunk: RagChunk, score: number, index: number): SourceHighlight {
  const sourceUrl = chunk.sourceUrl ?? source.sourceUrl;
  return {
    id: `semantic-rag-${chunk.id}`,
    title: chunk.title,
    url: sourceUrl || `local-import://${source.id}/${chunk.id}`,
    publisher: sourceUrl ? getReferenceMaterialPublisher(sourceUrl) : "手动导入",
    publishedAt: chunk.createdAt || source.createdAt,
    snippet: chunk.text,
    relevanceScore: Math.min(0.98, Number((0.62 + score * 0.03 - index * 0.02).toFixed(2))),
    usage: "interview-context"
  };
}
function buildStrategyChecklist(
  state: ProductState,
  input: {
    openingQuestion: string;
    debtToAddress?: string;
    recommendedPerspectives: string[];
    agendaContext?: string;
  }
) {
  return [
    `开场先落到具体事件：${input.openingQuestion}`,
    ...(input.agendaContext ? [`按主动搜集依据追问：${input.agendaContext}`] : []),
    ...collectAppliedPlaybookRules(state).slice(0, 2).map((rule) => `已应用样本技法：${rule}`),
    // 轻量推理(欠账②)消费:存在同主题对立观点时,提示主持人安排一次复盘。
    ...buildContradictionReviewHints(state),
    input.debtToAddress ? `第 2-3 轮回访知识债：${input.debtToAddress}` : "若用户出现新概念，生成知识债候选。",
    `中段至少引入两个视角：${input.recommendedPerspectives.slice(0, 2).join(" / ")}`,
    "所有外部素材必须作为追问线索，不直接替用户下结论。"
  ];
}

// 轻量推理(欠账②)消费:把 contradicts 软链翻成"对立观点复盘"提示。每对只提示一次
// (symmetric 去重,按 id 字典序),最多 2 条避免淹没 checklist;指向不存在 point 的悬挂软链跳过。
function buildContradictionReviewHints(state: ProductState): string[] {
  const pointById = new Map(state.points.map((p) => [p.id, p] as const));
  const seen = new Set<string>();
  const hints: string[] = [];
  for (const p of state.points) {
    for (const otherId of p.contradictsPointIds ?? []) {
      if (p.id === otherId) continue;
      const other = pointById.get(otherId);
      if (!other) continue;
      const [lo, hi] = p.id < otherId ? [p.id, otherId] : [otherId, p.id];
      const key = `${lo}|${hi}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hints.push(`你在「${p.title}」与「${other.title}」上有对立看法，值得本轮复盘是哪一方变了、为什么。`);
      if (hints.length >= 2) return hints;
    }
  }
  return hints;
}
function chooseRecommendedPerspectives(
  topicHint: string,
  searchBrief: SearchBrief | undefined,
  coverage: Record<string, number>,
  missingPerspectives: string[]
) {
  const candidates = [
    topicHint.includes("团队") || topicHint.includes("授权") ? "组织行为" : undefined,
    searchBrief ? "商业" : undefined,
    "系统论",
    missingPerspectives[0],
    topicHint.includes("判断") || topicHint.includes("边界") ? "形式科学" : undefined,
    "心理学"
  ].filter((item): item is string => Boolean(item));

  const unique = Array.from(new Set(candidates)).filter((perspective) => perspective in coverage);
  for (const perspective of defaultPerspectiveOrder) {
    if (unique.length >= 3) {
      break;
    }
    if (!unique.includes(perspective)) {
      unique.push(perspective);
    }
  }

  return unique.slice(0, 3);
}
export function collectAppliedPlaybookRules(state: ProductState) {
  return Array.from(
    new Set(
      state.playbookPatches
        .filter((patch) => patch.status === "applied")
        .flatMap((patch) => patch.rules)
        .map((rule) => rule.trim())
        .filter(Boolean)
    )
  );
}
export function collectAppliedPlaybookRuleTypes(state: ProductState) {
  return Array.from(
    new Set(
      state.playbookPatches
        .filter((patch) => patch.status === "applied")
        .flatMap((patch) => patch.ruleTypes ?? [])
        .map((ruleType) => ruleType.trim())
        .filter(Boolean)
    )
  );
}
function collectConfirmedMemoryTexts(state: ProductState) {
  // M4: single source of truth — confirmed memory texts come from memoryRecords only.
  return Array.from(
    new Set(
      state.memoryRecords
        .filter((record) => record.status === "confirmed")
        .map((record) => record.text.trim())
        .filter(Boolean)
    )
  );
}
/** P2b:按 recall.themeAssets 的 id 从内存 state 取资产文本(格式与现状 otherCandidates 一致)。 */
function collectThemeAssetTexts(state: ProductState, assets: NonNullable<RecallResult["themeAssets"]>): string[] {
  const pointById = new Map(state.points.map((p) => [p.id, p]));
  const decisionById = new Map(state.decisions.map((d) => [d.id, d]));
  const questionById = new Map(state.questions.map((q) => [q.id, q]));
  const texts: string[] = [];
  for (const id of assets.points) { const p = pointById.get(id); if (p) texts.push(`${p.title}：${p.content}`); }
  for (const id of assets.decisions) { const d = decisionById.get(id); if (d) texts.push(`${d.title}：${d.choice}`); }
  for (const id of assets.questions) { const q = questionById.get(id); if (q) texts.push(`${q.question}：${q.whyImportant}`); }
  return texts;
}
function collectRelevantMemories(
  state: ProductState,
  topicHint: string,
  contextPack: InterviewContextPack,
  queryEmbedding?: number[],
  now: string = nowIso(),
  recall?: RecallResult
) {
  const topicTokens = splitTopicTokens(topicHint);

  // 1) confirmed 长期记忆：三因子评分（relevance + recency + importance）精排。
  //    P2b:有 memoryHits(向量 HNSW 召回)时,记忆池 = memoryHits ∪ themeAssets.memories(图主题记忆)对应 record;
  //    无向量召回(如 voice 无 embedding)→ 全量回落,不降级。三因子精排不变。
  const memoryPool = recall?.memoryHits
    ? (() => {
        const ids = new Set<string>([...recall.memoryHits.map((h) => h.id), ...(recall.themeAssets?.memories ?? [])]);
        return contextPack.memoryRecords.filter((record) => ids.has(record.id));
      })()
    : contextPack.memoryRecords;
  const rankedMemoryTexts = [...memoryPool]
    .map((record) => ({
      text: record.text,
      score: scoreMemoryForRetrieval(record, { topicTokens, ...(queryEmbedding ? { queryEmbedding } : {}), now })
    }))
    .sort((a, b) => b.score - a.score)
    .map((item) => item.text);

  // 2) 其余资产。P2b:有 themeAssets → 精确按主题归属(point/decision/question,图序)+ 无图边的 notes/themes 现状;
  //    否则现状全量(笔记/观点/问题/决策/主题)子串排序。决策此前曾漏入语义召回,图遍历下天然覆盖。
  const otherCandidates = recall?.themeAssets
    ? [
        ...collectThemeAssetTexts(state, recall.themeAssets),
        ...state.notes.map((note) => `${note.title}：${note.summary}`),
        ...state.themes.map((theme) => `${theme.name}：${theme.summary}`)
      ]
    : [
        ...state.notes.map((note) => `${note.title}：${note.summary}`),
        ...state.points.map((point) => `${point.title}：${point.content}`),
        ...state.questions.map((question) => `${question.question}：${question.whyImportant}`),
        ...state.decisions.map((decision) => `${decision.title}：${decision.choice}`),
        ...state.themes.map((theme) => `${theme.name}：${theme.summary}`)
      ];
  // P2b:themeAssets 已精确按主题归属;组内按 topicHint 相关性**稳定排序但不过滤**(保全部归属资产,
  // 避免 SurrealDB 图序不稳定 + slice(0,5) 截掉更相关项);回落分支沿用 rankMemoryTexts(含子串过滤)。
  const rankedOthers = recall?.themeAssets
    ? [...otherCandidates]
        .map((text, i) => ({ text, i, score: topicTokens.reduce((s, tok) => s + (text.includes(tok) ? 1 : 0), 0) }))
        .sort((a, b) => b.score - a.score || a.i - b.i)
        .map((x) => x.text)
    : rankMemoryTexts(otherCandidates, topicHint);

  // 记忆优先于其余资产，去重后取前 5。
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const text of [...rankedMemoryTexts, ...rankedOthers]) {
    if (!seen.has(text)) {
      seen.add(text);
      merged.push(text);
    }
  }
  return merged.slice(0, 5);
}
function countOccurrences(text: string, signal: string) {
  return text.split(signal).length - 1;
}
export function createSessionDraft(
  state: ProductState,
  mode: InterviewMode = "daily",
  strength: InterviewStrength = state.profile.preferredStrength,
  options: CreateSessionOptions = {}
): InterviewSession {
  const guide = buildInterviewGuide(state, {
    ...(options.searchBriefId ? { searchBriefId: options.searchBriefId } : {}),
    ...(options.topicHint ? { topicHint: options.topicHint } : {}),
    ...(options.queryEmbedding ? { queryEmbedding: options.queryEmbedding } : {})
  }, options.recall);
  const card = buildInterviewCard(state, options.searchBriefId, options.topicHint, options.queryEmbedding, options.recall, guide);
  return {
    id: makeId("session"),
    mode,
    strength,
    status: "active",
    title: `${modeLabels[mode]}：${card.title}`,
    card,
    guide,
    turns: [],
    enginePolicy: buildInterviewEnginePolicy(state),
    startedAt: nowIso()
  };
}
const perspectiveSignals: Record<string, string[]> = {
  "系统论": ["机制", "系统", "奖励", "惯性", "依赖"],
  "组织行为": ["团队", "授权", "拍板", "责任", "组织"],
  "形式科学": ["判断", "标准", "验证", "拆成", "边界"],
  "心理学": ["担心", "害怕", "信任", "控制感", "焦虑"],
  "商业": ["产品", "商业", "客户", "项目", "流程"],
  "叙事": ["原话", "故事", "角色", "访谈", "记录"],
  "人类学": ["文化", "处境", "关系", "习惯", "仪式"]
};
const defaultPerspectiveOrder = Object.keys(perspectiveSignals);

function emptySemanticRagContext(): SemanticRagContext {
  return {
    chunks: [],
    sourceHighlights: [],
    importSources: []
  };
}
function ensureSentenceEnd(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  return /[。！？!?]$/.test(trimmed) ? trimmed : `${trimmed}。`;
}
function findLastTurn(session: InterviewSession, role: InterviewTurn["role"]) {
  for (let index = session.turns.length - 1; index >= 0; index -= 1) {
    if (session.turns[index].role === role) {
      return session.turns[index];
    }
  }
  return undefined;
}
function findNextInterviewFocusQuestion(state: ProductState) {
  return state.questions.find(
    (question) =>
      question.status === "正在聚焦" &&
      question.important &&
      question.whyImportant.includes("会后反馈")
  );
}
function formatExternalMaterial(label: "外部资料" | "外部观点", searchBrief: SearchBrief, text: string) {
  return `${label}（来源：${getSearchSourceLabelForClaim(searchBrief, text)}）：${text}`;
}
export function formatMemoryGraphTargetLabel(text: string) {
  return text.length > 28 ? `${text.slice(0, 28)}...` : text;
}
function formatQuestionTitle(question: string) {
  return question.replace(/^下次继续追问/, "").replace(/[。！？!?]+$/g, "").trim() || question;
}
function formatRagChunkSourceLabel(state: ProductState, chunk: RagChunk) {
  const source = state.importSources.find((item) => item.id === chunk.sourceId);
  const sourceUrl = chunk.sourceUrl ?? source?.sourceUrl;
  return sourceUrl ? getReferenceMaterialPublisher(sourceUrl) : source?.title ?? "导入资料";
}
function formatSearchAgendaIntent(intent: SearchBriefAgendaTrace["intent"]) {
  const labels: Record<SearchBriefAgendaTrace["intent"], string> = {
    hotspot: "热点追踪",
    "knowledge-refresh": "知识更新",
    counterpoint: "反方校验",
    "memory-cross-check": "记忆交叉验证"
  };
  return labels[intent];
}
function formatSearchAgendaTraceForInterview(trace: SearchBriefAgendaTrace) {
  const seedAssets = trace.seedAssetIds.length > 0 ? `；关联资产：${trace.seedAssetIds.join(" / ")}` : "";
  return `主动搜集依据（${formatSearchAgendaIntent(trace.intent)} · ${trace.source}）：${trace.reason}${seedAssets}`;
}
function getPrimarySearchSourceLabel(searchBrief: SearchBrief) {
  return searchBrief.sources[0]?.publisher || searchBrief.provider;
}
function getSearchSourceLabelForClaim(searchBrief: SearchBrief, claim: string) {
  const trace = searchBrief.sourceTrace?.find((item) => item.claim === claim);
  if (!trace) {
    return getPrimarySearchSourceLabel(searchBrief);
  }
  const explicitLabels = trace.sourceLabels.filter(Boolean);
  if (explicitLabels.length > 0) {
    return explicitLabels.join(" / ");
  }
  const sourceLabels = trace.sourceIds
    .map((sourceId) => searchBrief.sources.find((source) => source.id === sourceId))
    .filter((source): source is SourceHighlight => Boolean(source))
    .map(formatSearchTraceSourceLabel);
  return sourceLabels.length > 0 ? sourceLabels.join(" / ") : getPrimarySearchSourceLabel(searchBrief);
}
function getSessionLastUpdatedAt(session: InterviewSession) {
  return session.turns.at(-1)?.timestamp ?? session.startedAt;
}
function hasMemoryGraphTokenOverlap(left: Set<string>, right: Set<string>) {
  for (const token of left) {
    if (right.has(token)) {
      return true;
    }
  }
  return false;
}
function isImportSourceAllowedInContext(source: ImportSource, memoryPolicy: ProductState["systemConfig"]["memory"]) {
  return source.sensitivity !== "sensitive" || memoryPolicy.includeSensitiveMemoriesInContext;
}
function isModelSafeMemoryRecord(record: MemoryRecord) {
  return (record.sensitivity ?? "normal") !== "sensitive";
}
function isSearchBriefAllowedInInterviewContext(state: ProductState, brief: SearchBrief) {
  const linkedImportSource = state.importSources.find((source) => source.searchBriefId === brief.id);
  if (!linkedImportSource) {
    return true;
  }
  return linkedImportSource.sensitivity !== "sensitive" || state.systemConfig.memory.includeSensitiveMemoriesInContext;
}
function isSearchBriefDiscussionTopic(searchBrief: SearchBrief | undefined, topicHint: string | undefined) {
  if (!searchBrief || !topicHint) {
    return false;
  }
  // ponytail: normalized bidirectional containment instead of exact ===, so a topic
  // hint that isn't a byte-for-byte copy of brief.topic no longer silently drops the
  // tracked brief. Over-match (feeding a loosely-related brief) is safer than dropping.
  const hint = topicHint.trim().toLowerCase();
  if (!hint) {
    return false;
  }
  return [searchBrief.topic, ...searchBrief.discussionTopics].some((topic) => {
    const candidate = topic.trim().toLowerCase();
    return candidate === hint || candidate.includes(hint) || hint.includes(candidate);
  });
}
const memoryGraphStopTokens = new Set([
  "用户",
  "确认",
  "这个",
  "不是",
  "而是",
  "因为",
  "每次",
  "继续",
  "问题",
  "关键",
  "应该",
  "可以",
  "如果",
  "自己",
  "他们",
  "一个",
  "需要",
  "具体",
  "真实",
  "系统"
]);

// M3c: rank confirmed MemoryRecords with the three-factor scorer (cosine when both
// queryEmbedding and record.embedding are present, else substring). Pure — `now` is
// captured once here for stable ordering within a single build.
function rankMemoryRecordsBySemantics(records: MemoryRecord[], topicHint: string, queryEmbedding: number[]) {
  const topicTokens = splitTopicTokens(topicHint);
  const now = nowIso();
  return [...records]
    .map((record) => ({
      text: record.text,
      score: scoreMemoryForRetrieval(record, { topicTokens, queryEmbedding, now })
    }))
    .sort((a, b) => b.score - a.score)
    .map((item) => item.text);
}
function rankMemoryTexts(memoryCandidates: string[], topicHint: string) {
  const tokens = splitTopicTokens(topicHint);
  const scored = memoryCandidates
    .map((memory) => ({
      memory,
      score: tokens.reduce((score, token) => score + (memory.includes(token) ? 1 : 0), 0)
    }))
    .sort((a, b) => b.score - a.score);
  return scored
    .filter((item, index) => item.score > 0 || index < 3)
    .map((item) => item.memory);
}

/**
 * M3b: 记忆检索三因子评分（借鉴 Generative Agents：relevance + recency + importance）。
 *
 * 纯函数 — 不调用 `Date.now()`/`new Date()`，当前时间通过 `opts.now`（ISO 字符串）传入。
 * 时间字符串用 `Date.parse` 解析；解析失败（NaN）或未来时间导致的负 hoursSince 一律按 0 兜底。
 *
 * - relevance：同时有 `queryEmbedding` 与 `record.embedding` 时走 cosine（负值截 0，落到 0..1）；
 *   否则退回子串/token 命中率（命中 token 数 / 总 token 数，0..1），与旧的 `rankMemoryTexts` 子串逻辑一致。
 * - recency：`0.995^hoursSince`，基于 `lastAccessedAt ?? createdAt`。
 * - importance：`(importance ?? 5) / 10`。
 *
 * @returns 加权得分（默认权重 0.6/0.25/0.15）。
 */
export function scoreMemoryForRetrieval(
  record: MemoryRecord,
  opts: { topicTokens: string[]; queryEmbedding?: number[]; now: string; alpha?: number; beta?: number; gamma?: number }
): number {
  const { topicTokens, queryEmbedding, now } = opts;
  const alpha = opts.alpha ?? 0.6;
  const beta = opts.beta ?? 0.25;
  const gamma = opts.gamma ?? 0.15;

  // relevance ∈ [0,1]
  let relevance: number;
  if (queryEmbedding && queryEmbedding.length > 0 && record.embedding && record.embedding.length > 0) {
    relevance = Math.max(0, cosineSimilarity(queryEmbedding, record.embedding));
  } else {
    const tokens = topicTokens.filter((token) => token.length > 0);
    if (tokens.length === 0) {
      relevance = 0;
    } else {
      const hits = tokens.reduce((count, token) => count + (record.text.includes(token) ? 1 : 0), 0);
      relevance = hits / tokens.length;
    }
  }

  // recency ∈ (0,1]，未来/不可解析时间兜底为 0
  const referenceTime = Date.parse(record.lastAccessedAt ?? record.createdAt);
  const nowTime = Date.parse(now);
  let recency = 0;
  if (Number.isFinite(referenceTime) && Number.isFinite(nowTime)) {
    const hoursSince = (nowTime - referenceTime) / 3.6e6;
    recency = hoursSince >= 0 ? Math.pow(0.995, hoursSince) : 0;
  }

  // importance ∈ [0,1]
  const importance = (record.importance ?? 5) / 10;

  return alpha * relevance + beta * recency + gamma * importance;
}
function resolveInterviewContextSearchBrief(state: ProductState, options: InterviewGuideOptions = {}) {
  const explicitTopicHint = options.topicHint?.trim();
  const requestedSearchBrief = resolveInterviewSearchBrief(state, options.searchBriefId);
  if (explicitTopicHint && !isSearchBriefDiscussionTopic(requestedSearchBrief, explicitTopicHint)) {
    return undefined;
  }
  return requestedSearchBrief;
}
function resolveInterviewSearchBrief(state: ProductState, searchBriefId?: string) {
  if (!state.systemConfig.search.allowWebInInterview) {
    return undefined;
  }
  if (searchBriefId) {
    // 显式指定 id 时按 id 查找，行为不变
    const brief = state.searchBriefs.find((item) => item.id === searchBriefId);
    return brief && isSearchBriefAllowedInInterviewContext(state, brief) ? brief : undefined;
  }
  // 无显式 id 时：优先选最近的 tracked:true 且允许进上下文的 brief（兑现"持续追踪自动喂专访"语义）
  const trackedBrief = state.searchBriefs.find(
    (item) => item.tracked && isSearchBriefAllowedInInterviewContext(state, item)
  );
  if (trackedBrief) {
    return trackedBrief;
  }
  // 无 tracked brief 时回退到原 [0] 逻辑
  const first = state.searchBriefs[0];
  return first && isSearchBriefAllowedInInterviewContext(state, first) ? first : undefined;
}
function scoreRagChunkForTopic(chunk: RagChunk, source: ImportSource, topicTokens: Set<string>) {
  const primaryTokens = tokenizeMemoryGraphText(chunk.text);
  const metadataTokens = tokenizeMemoryGraphText([source.title, chunk.title, ...chunk.keywords].join(" "));
  return Array.from(topicTokens).reduce((score, token) => {
    const baseScore = token.length >= 3 ? 2 : 1;
    const primaryScore = primaryTokens.has(token) ? baseScore * 2 : 0;
    const metadataScore = metadataTokens.has(token) ? baseScore * 0.5 : 0;
    return score + primaryScore + metadataScore;
  }, 0);
}
function searchBriefHasRemovedExternalInstruction(searchBrief: SearchBrief) {
  return [
    searchBrief.summary,
    ...searchBrief.facts,
    ...searchBrief.controversies,
    ...searchBrief.opposingViews,
    ...searchBrief.interviewAngles,
    ...searchBrief.discussionTopics,
    ...searchBrief.sourceAngles,
    ...searchBrief.sources.flatMap((source) => [source.title, source.publisher, source.snippet])
  ].some((value) => value.includes(removedExternalInstruction));
}
function splitTopicTokens(topicHint: string) {
  return Array.from(new Set(topicHint.split(/[、，。,.!?！？\s]+/).flatMap((item) => {
    const token = item.trim();
    if (!token) {
      return [];
    }
    if (token.length <= 2) {
      return [token];
    }
    return [token, token.slice(0, 2), token.slice(-2)];
  })));
}
export function tokenizeMemoryGraphText(text: string) {
  const tokens = new Set<string>();
  const lower = text.toLowerCase();
  for (const word of lower.match(/[a-z0-9][a-z0-9_-]{1,}/g) ?? []) {
    addMemoryGraphToken(tokens, word);
  }
  for (const segment of text.match(/[\u4e00-\u9fff]{2,}/g) ?? []) {
    if (segment.length <= 8) {
      addMemoryGraphToken(tokens, segment);
    }
    for (const size of [2, 3, 4]) {
      for (let index = 0; index <= segment.length - size; index += 1) {
        addMemoryGraphToken(tokens, segment.slice(index, index + size));
      }
    }
  }
  return tokens;
}
