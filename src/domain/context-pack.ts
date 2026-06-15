import type {
  InterviewCard,
  InterviewContextPack,
  InterviewFollowUpItem,
  InterviewGuide,
  InterviewGuideOptions,
  InterviewMode,
  InterviewResumeCard,
  InterviewSession,
  InterviewTurn,
  InterviewStrength,
  ImportSource,
  MemoryEdge,
  MemoryGraphReference,
  MemoryGraphRelation,
  MemoryGraphTargetType,
  MemoryRecord,
  ProductState,
  RagChunk,
  SearchBrief,
  SearchBriefAgendaTrace,
  SourceHighlight,
  SystemConfig,
} from "./types";

import { cloneState, makeId, nowIso, withAuditEvent, withAiRunEvent, formatSearchTraceSourceLabel, getReferenceMaterialPublisher, daysBetween, modeLabels, removedExternalInstruction } from "./utils";

import { buildInterviewEnginePolicy } from "./strategy";

type MemoryGraphTargetCandidate = {
  targetType: MemoryGraphTargetType;
  targetId: string;
  targetLabel: string;
  relation: MemoryGraphRelation;
  corpus: string;
};
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
      reason: "如果用户一直是救火者，就需要看见自己是否被固定在某个角色叙事里。"
    },
    "商业": {
      concept: "授权选择的业务代价",
      importance: "high",
      reason: "讨论授权不能只停在管理理念，还要落到延期、质量、客户和节奏的业务代价。"
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
          reason: "当前资产已经反复出现救火和授权，但仍需要把最坏情况拆成可验证风险。"
        }
      ];
}
function buildContextPackMemoryEdges(state: ProductState, memoryRecords: MemoryRecord[], topicHint: string) {
  const visibleMemoryRecordIds = new Set(memoryRecords.map((record) => record.id));
  const recordsById = new Map(memoryRecords.map((record) => [record.id, record]));
  const topicTokens = tokenizeMemoryGraphText(topicHint);
  return (state.memoryEdges ?? [])
    .filter((edge) => visibleMemoryRecordIds.has(edge.fromMemoryRecordId))
    .filter((edge) => {
      if (topicTokens.size === 0) {
        return true;
      }
      const record = recordsById.get(edge.fromMemoryRecordId);
      const edgeTokens = tokenizeMemoryGraphText(
        [record?.text, record?.evidenceQuote, resolveMemoryGraphTargetCorpus(state, edge), edge.evidenceQuote, edge.label]
          .filter(Boolean)
          .join(" ")
      );
      return hasMemoryGraphTokenOverlap(topicTokens, edgeTokens);
    })
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 16);
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
function buildDecisionReviewPrompt(decision: ProductState["decisions"][number]) {
  return `复盘决策“${decision.title}”：当时的选择是否降低了短期风险，还是继续强化了等待拍板？`;
}
export function buildInterviewCard(state: ProductState, searchBriefId?: string, topicHint?: string): InterviewCard {
  const topTheme = [...state.themes].sort((a, b) => b.appearances - a.appearances)[0];
  const themeName = topTheme?.name ?? "当前问题";
  const openDebt = state.debts.find((debt) => debt.status === "待了解") ?? state.debts[0];
  const confirmedMemoryTexts = collectConfirmedMemoryTexts(state);
  const reference = topTheme?.representativeQuote ?? confirmedMemoryTexts[0] ?? "你最近有一个反复出现的问题。";
  const explicitTopicHint = topicHint?.trim();
  const contextOptions = {
    ...(searchBriefId ? { searchBriefId } : {}),
    ...(explicitTopicHint ? { topicHint: explicitTopicHint } : {})
  };
  const searchBrief = resolveInterviewContextSearchBrief(state, contextOptions);
  const contextPack = buildInterviewContextPack(state, contextOptions);
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
  const guide = buildInterviewGuide(state, contextOptions);
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
    historyReferences: Array.from(new Set([...(agendaContext ? [agendaContext] : []), ...sourceReferences, reference, ...confirmedMemoryTexts])).slice(0, 4),
    potentialTension: searchBrief?.sourceAngles[0] ?? contextPack.ragChunks[0]?.text ?? neutralTension,
    suggestedPerspectives: guide.recommendedPerspectives,
    likelyOutputs: [
      "一个更准确的长期问题",
      openDebt ? `知识债回访：${openDebt.concept}` : "一个新的知识债候选",
      topTheme ? `关于「${topTheme.name}」的新观点` : "一条可沉淀的观察",
      ...(hasContextSources ? [`素材引用：${contextSourceHighlights[0]?.title}`] : [])
    ],
    searchBriefId: searchBrief?.id,
    sourceHighlights: hasContextSources ? contextSourceHighlights : undefined
  };
}

export interface CreateSessionOptions {
  searchBriefId?: string;
  topicHint?: string;
}

export function buildInterviewContextPack(state: ProductState, options: InterviewGuideOptions = {}): InterviewContextPack {
  const topicHint = options.topicHint?.trim() || state.themes[0]?.name || state.profile.currentFocus;
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
  const semanticRagContext = linkedImportSource
    ? emptySemanticRagContext()
    : buildSemanticRagContext(state, topicHint, contextSourceLimit);
  const ragChunks = linkedImportSource ? linkedRagChunks : semanticRagContext.chunks;
  const sourceHighlights = [...searchSourceHighlights, ...semanticRagContext.sourceHighlights].slice(0, sourceHighlightLimit);
  const activeRecords = state.memoryRecords.filter(
    (record) =>
      record.status === "confirmed" &&
      (memoryPolicy.includeSensitiveMemoriesInContext || isModelSafeMemoryRecord(record))
  );
  const governedMemoryTexts = new Set(state.memoryRecords.map((record) => record.text.trim()).filter(Boolean));
  const profileMemoryRecords: MemoryRecord[] = state.profile.confirmedMemories
    .map((memory) => memory.trim())
    .filter((memory) => memory && !governedMemoryTexts.has(memory))
    .map((memory, index) => ({
      id: `profile-confirmed-${index + 1}`,
      text: memory,
      status: "confirmed",
      sourceType: "profile",
      sourceId: state.profile.name || "profile",
      evidenceQuote: memory,
      sensitivity: "normal",
      createdAt: "2026-06-10T00:00:00.000Z",
      updatedAt: "2026-06-10T00:00:00.000Z"
    }));
  const memoryRecords = [...activeRecords, ...profileMemoryRecords];
  const confirmedMemories = rankMemoryTexts(memoryRecords.map((record) => record.text), topicHint);
  const memoryEdges = buildContextPackMemoryEdges(state, memoryRecords, topicHint);
  const graphReferences = buildMemoryGraphReferences(memoryEdges, state);
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
    corrections: state.memoryCorrections,
    memoryEdges,
    graphReferences,
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
export function buildInterviewFollowUpQueue(state: ProductState, limit = 6): InterviewFollowUpItem[] {
  const candidates: InterviewFollowUpItem[] = [
    ...state.questions
      .filter((question) => ["正在聚焦", "反复出现", "开放"].includes(question.status))
      .map((question) => ({
        id: `followup-question-${question.id}`,
        sourceType: "question" as const,
        sourceId: question.id,
        title: formatQuestionFollowUpTitle(question),
        prompt: question.question,
        reason: buildQuestionFollowUpReason(question),
        priority: scoreQuestionFollowUp(question),
        mode: "decision" as const,
        updatedAt: question.updatedAt
      })),
    ...state.debts
      .filter((debt) => debt.status === "待了解")
      .map((debt) => ({
        id: `followup-debt-${debt.id}`,
        sourceType: "knowledge_debt" as const,
        sourceId: debt.id,
        title: `知识债：${debt.concept}`,
        prompt: debt.nextQuestion,
        reason: `未完成知识债：${debt.whyImportant}`,
        priority: scoreDebtFollowUp(debt),
        mode: "learning" as const,
        updatedAt: debt.updatedAt
      })),
    ...state.decisions
      .filter((decision) => decision.confirmationStatus === "用户确认" && decision.status === "待复盘")
      .map((decision) => ({
        id: `followup-decision-${decision.id}`,
        sourceType: "decision_review" as const,
        sourceId: decision.id,
        title: `决策复盘：${decision.title}`,
        prompt: buildDecisionReviewPrompt(decision),
        reason: `复盘日期 ${decision.reviewAt}：${decision.riskHypothesis}`,
        priority: scoreDecisionFollowUp(decision),
        mode: "decision" as const,
        updatedAt: decision.updatedAt
      })),
    ...state.themes
      .filter((theme) => theme.maturity !== "关闭")
      .map((theme) => ({
        id: `followup-theme-${theme.id}`,
        sourceType: "theme" as const,
        sourceId: theme.id,
        title: `长期主题：${theme.name}`,
        prompt: theme.nextQuestion,
        reason: `长期主题已出现 ${theme.appearances} 次：${theme.summary}`,
        priority: scoreThemeFollowUp(theme),
        mode: "long-term" as const,
        updatedAt: theme.updatedAt
      }))
  ];

  const seenPrompts = new Set<string>();
  return candidates
    .filter((item) => {
      const normalizedPrompt = normalizeFollowUpPrompt(item.prompt);
      if (!normalizedPrompt || seenPrompts.has(normalizedPrompt)) {
        return false;
      }
      seenPrompts.add(normalizedPrompt);
      return true;
    })
    .sort((left, right) => right.priority - left.priority || Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
    .slice(0, limit);
}
export function buildInterviewGuide(state: ProductState, options: InterviewGuideOptions = {}): InterviewGuide {
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
  const topicHint = explicitTopicHint || searchBrief?.topic || focusQuestion?.question || topTheme?.name || state.profile.currentFocus;
  const contextPack = buildInterviewContextPack(state, {
    topicHint,
    ...(options.searchBriefId ? { searchBriefId: options.searchBriefId } : {})
  });
  const perspectiveCoverage = buildPerspectiveCoverage(state);
  const missingPerspectives = defaultPerspectiveOrder.filter((perspective) => perspectiveCoverage[perspective] === 0);
  const recommendedPerspectives = chooseRecommendedPerspectives(topicHint, searchBrief, perspectiveCoverage, missingPerspectives);
  const relevantMemories = collectRelevantMemories(state, topicHint, contextPack);
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
export function buildMemoryEdgeLabel(relation: MemoryGraphRelation, targetLabel: string) {
  return `${getMemoryGraphRelationLabel(relation)}：${targetLabel}`;
}
export function buildMemoryEdgesForRecord(state: ProductState, record: MemoryRecord, createdAt: string): MemoryEdge[] {
  const sourceTokens = tokenizeMemoryGraphText(`${record.text} ${record.evidenceQuote}`);
  if (sourceTokens.size === 0) {
    return [];
  }

  const existingKeys = new Set(
    (state.memoryEdges ?? []).map((edge) => `${edge.fromMemoryRecordId}:${edge.targetType}:${edge.targetId}:${edge.relation}`)
  );
  const candidates: MemoryGraphTargetCandidate[] = [
    ...state.themes.map((theme) => ({
      targetType: "long_term_theme" as const,
      targetId: theme.id,
      targetLabel: theme.name,
      relation: "relates_to" as const,
      corpus: [theme.name, theme.summary, theme.representativeQuote, theme.nextQuestion].join(" ")
    })),
    ...state.questions.map((question) => ({
      targetType: "question" as const,
      targetId: question.id,
      targetLabel: question.question,
      relation: "revisits" as const,
      corpus: [question.question, question.whyImportant, question.nextPrompt].join(" ")
    })),
    ...state.debts.map((debt) => ({
      targetType: "knowledge_debt" as const,
      targetId: debt.id,
      targetLabel: debt.concept,
      relation: "raises_debt" as const,
      corpus: [debt.concept, debt.context, debt.whyImportant, debt.nextQuestion].join(" ")
    })),
    ...state.points.map((point) => ({
      targetType: "point" as const,
      targetId: point.id,
      targetLabel: point.title,
      relation: "supports" as const,
      corpus: [point.title, point.content, ...point.evidence].join(" ")
    })),
    ...state.decisions.map((decision) => ({
      targetType: "decision" as const,
      targetId: decision.id,
      targetLabel: decision.title,
      relation: "supports" as const,
      corpus: [decision.title, decision.choice, decision.tradeOff, decision.riskHypothesis].join(" ")
    })),
    ...state.memoryRecords
      .filter((memory) => memory.id !== record.id && memory.status === "confirmed")
      .map((memory) => ({
        targetType: "memory_record" as const,
        targetId: memory.id,
        targetLabel: formatMemoryGraphTargetLabel(memory.text),
        relation: "contrasts_with" as const,
        corpus: [memory.text, memory.evidenceQuote].join(" ")
      }))
  ];

  return candidates
    .map((candidate) => {
      const targetTokens = tokenizeMemoryGraphText(candidate.corpus);
      const sharedTokens = Array.from(sourceTokens).filter((token) => targetTokens.has(token));
      const score = sharedTokens.reduce((total, token) => total + (token.length >= 3 ? 1.5 : 1), 0);
      return { ...candidate, score, sharedTokens };
    })
    .filter((candidate) => candidate.score >= 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, 12)
    .filter((candidate) => !existingKeys.has(`${record.id}:${candidate.targetType}:${candidate.targetId}:${candidate.relation}`))
    .map((candidate) => ({
      id: makeId("memory-edge"),
      fromMemoryRecordId: record.id,
      targetType: candidate.targetType,
      targetId: candidate.targetId,
      relation: candidate.relation,
      label: buildMemoryEdgeLabel(candidate.relation, candidate.targetLabel),
      evidenceQuote: `共享线索：${candidate.sharedTokens.slice(0, 4).join(" / ")}`,
      weight: Math.min(0.95, Number((0.45 + candidate.score * 0.08).toFixed(2))),
      createdAt
    }));
}
function buildMemoryGraphReferences(edges: MemoryEdge[], state: ProductState): MemoryGraphReference[] {
  return edges
    .map((edge) => {
      const targetLabel = resolveMemoryGraphTargetLabel(state, edge);
      if (!targetLabel) {
        return undefined;
      }
      const relationLabel = getMemoryGraphRelationLabel(edge.relation);
      return {
        edgeId: edge.id,
        memoryRecordId: edge.fromMemoryRecordId,
        targetType: edge.targetType,
        targetId: edge.targetId,
        targetLabel,
        relation: edge.relation,
        reason: `${relationLabel}“${targetLabel}”提供二跳召回依据：${edge.evidenceQuote}`,
        weight: edge.weight
      };
    })
    .filter((reference): reference is MemoryGraphReference => Boolean(reference));
}
function buildOpinionEvolution(state: ProductState): InterviewGuide["opinionEvolution"] {
  const note = state.notes[0];
  const point = state.points[0];
  if (!note || !point) {
    return [];
  }

  return [
    {
      topic: state.themes[0]?.name ?? "长期主题",
      oldView: note.saidTrack[0] ?? note.keyQuote,
      newView: point.content,
      date: point.updatedAt
    }
  ];
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
function buildQuestionFollowUpReason(question: ProductState["questions"][number]) {
  if (isUserRequestedFollowUpQuestion(question)) {
    return `用户会后反馈明确要求继续追问：${question.nextPrompt}`;
  }
  if (question.status === "正在聚焦") {
    return `正在聚焦的问题：${question.whyImportant}`;
  }
  return `${question.status}问题：${question.whyImportant}`;
}
function buildSemanticRagContext(state: ProductState, topicHint: string, limit: number): SemanticRagContext {
  const topicTokens = tokenizeMemoryGraphText(topicHint);
  if (topicTokens.size === 0 || state.ragChunks.length === 0) {
    return emptySemanticRagContext();
  }

  const sourcesById = new Map(state.importSources.map((source) => [source.id, source]));
  const matches = state.ragChunks
    .map((chunk) => {
      const source = sourcesById.get(chunk.sourceId);
      if (!source || chunk.usage !== "interview-context" || !isImportSourceAllowedInContext(source, state.systemConfig.memory)) {
        return undefined;
      }
      return {
        chunk,
        source,
        score: scoreRagChunkForTopic(chunk, source, topicTokens)
      };
    })
    .filter((match): match is { chunk: RagChunk; source: ImportSource; score: number } => Boolean(match))
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
    input.debtToAddress ? `第 2-3 轮回访知识债：${input.debtToAddress}` : "若用户出现新概念，生成知识债候选。",
    `中段至少引入两个视角：${input.recommendedPerspectives.slice(0, 2).join(" / ")}`,
    "所有外部素材必须作为追问线索，不直接替用户下结论。"
  ];
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
function collectConfirmedMemoryTexts(state: ProductState) {
  const governedMemoryTexts = new Set(state.memoryRecords.map((record) => record.text.trim()).filter(Boolean));
  return Array.from(
    new Set([
      ...state.memoryRecords
        .filter((record) => record.status === "confirmed")
        .map((record) => record.text.trim())
        .filter(Boolean),
      ...state.profile.confirmedMemories
        .map((memory) => memory.trim())
        .filter((memory) => memory && !governedMemoryTexts.has(memory))
    ])
  );
}
function collectRelevantMemories(state: ProductState, topicHint: string, contextPack: InterviewContextPack) {
  const memoryCandidates = [
    ...contextPack.confirmedMemories,
    ...state.notes.map((note) => `${note.title}：${note.summary}`),
    ...state.points.map((point) => `${point.title}：${point.content}`),
    ...state.questions.map((question) => `${question.question}：${question.whyImportant}`),
    ...state.themes.map((theme) => `${theme.name}：${theme.summary}`)
  ];
  return rankMemoryTexts(memoryCandidates, topicHint).slice(0, 5);
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
    ...(options.topicHint ? { topicHint: options.topicHint } : {})
  });
  const card = buildInterviewCard(state, options.searchBriefId, options.topicHint);
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
function formatQuestionFollowUpTitle(question: ProductState["questions"][number]) {
  return isUserRequestedFollowUpQuestion(question) ? `用户标记：${formatQuestionTitle(question.question)}` : question.question;
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
export function getMemoryGraphRelationLabel(relation: MemoryGraphRelation) {
  if (relation === "relates_to") {
    return "长期主题";
  }
  if (relation === "revisits") {
    return "历史问题";
  }
  if (relation === "raises_debt") {
    return "知识债";
  }
  if (relation === "supports") {
    return "支撑资产";
  }
  return "相邻记忆";
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
  return searchBrief.topic === topicHint || searchBrief.discussionTopics.some((topic) => topic === topicHint);
}
function isUserRequestedFollowUpQuestion(question: ProductState["questions"][number]) {
  return question.whyImportant.includes("会后反馈") || question.question.startsWith("下次继续追问");
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

function normalizeFollowUpPrompt(prompt: string) {
  return prompt.replace(/\s+/g, "").replace(/[。！？!?]+$/g, "");
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
  const brief = searchBriefId ? state.searchBriefs.find((item) => item.id === searchBriefId) : state.searchBriefs[0];
  return brief && isSearchBriefAllowedInInterviewContext(state, brief) ? brief : undefined;
}
function resolveMemoryGraphTargetCorpus(state: ProductState, edge: Pick<MemoryEdge, "targetType" | "targetId">) {
  if (edge.targetType === "long_term_theme") {
    const theme = state.themes.find((item) => item.id === edge.targetId);
    return theme ? [theme.name, theme.summary, theme.representativeQuote, theme.nextQuestion].join(" ") : "";
  }
  if (edge.targetType === "question") {
    const question = state.questions.find((item) => item.id === edge.targetId);
    return question ? [question.question, question.whyImportant, question.nextPrompt].join(" ") : "";
  }
  if (edge.targetType === "knowledge_debt") {
    const debt = state.debts.find((item) => item.id === edge.targetId);
    return debt ? [debt.concept, debt.context, debt.whyImportant, debt.nextQuestion].join(" ") : "";
  }
  if (edge.targetType === "point") {
    const point = state.points.find((item) => item.id === edge.targetId);
    return point ? [point.title, point.content, ...point.evidence].join(" ") : "";
  }
  if (edge.targetType === "decision") {
    const decision = state.decisions.find((item) => item.id === edge.targetId);
    return decision ? [decision.title, decision.choice, decision.tradeOff, decision.riskHypothesis].join(" ") : "";
  }
  const memory = state.memoryRecords.find((record) => record.id === edge.targetId);
  return memory ? [memory.text, memory.evidenceQuote].join(" ") : "";
}
function resolveMemoryGraphTargetLabel(state: ProductState, edge: Pick<MemoryEdge, "targetType" | "targetId">) {
  if (edge.targetType === "long_term_theme") {
    return state.themes.find((theme) => theme.id === edge.targetId)?.name;
  }
  if (edge.targetType === "question") {
    return state.questions.find((question) => question.id === edge.targetId)?.question;
  }
  if (edge.targetType === "knowledge_debt") {
    return state.debts.find((debt) => debt.id === edge.targetId)?.concept;
  }
  if (edge.targetType === "point") {
    return state.points.find((point) => point.id === edge.targetId)?.title;
  }
  if (edge.targetType === "decision") {
    return state.decisions.find((decision) => decision.id === edge.targetId)?.title;
  }
  return state.memoryRecords.find((record) => record.id === edge.targetId)?.text;
}
function scoreDebtFollowUp(debt: ProductState["debts"][number]) {
  const staleDays = daysBetween(debt.updatedAt, nowIso());
  return Math.min(88, 70 + Math.min(12, staleDays) + (debt.whyImportant.includes("授权") ? 6 : 0));
}
function scoreDecisionFollowUp(decision: ProductState["decisions"][number]) {
  const daysUntilReview = daysBetween(nowIso(), decision.reviewAt);
  const dueScore = daysUntilReview <= 0 ? 20 : daysUntilReview <= 7 ? 14 : 6;
  return Math.min(92, 72 + dueScore + (decision.decisionKind === "用户决策" ? 6 : 0));
}
function scoreQuestionFollowUp(question: ProductState["questions"][number]) {
  const statusScore = question.status === "正在聚焦" ? 78 : question.status === "反复出现" ? 68 : 56;
  const importanceScore = question.important ? 12 : 0;
  const appearanceScore = Math.min(12, question.appearances * 3);
  const feedbackScore = isUserRequestedFollowUpQuestion(question) ? 25 : 0;
  return Math.min(100, statusScore + importanceScore + appearanceScore + feedbackScore);
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
function scoreThemeFollowUp(theme: ProductState["themes"][number]) {
  const maturityScore: Record<ProductState["themes"][number]["maturity"], number> = {
    萌芽: 48,
    重复: 62,
    聚焦: 72,
    成型: 66,
    变化: 70,
    关闭: 0
  };
  return Math.min(84, maturityScore[theme.maturity] + Math.min(10, theme.appearances * 2));
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
