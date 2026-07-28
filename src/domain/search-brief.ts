import type {
  KnowledgeDebt,
  MemoryCandidate,
  PointAsset,
  ProductState,
  QuestionAsset,
  SearchAgendaItem,
  SearchBrief,
  SearchBriefAgendaTrace,
  SearchBriefClaimType,
  SearchBriefInput,
  SearchBriefSourceTrace,
  SearchProviderId,
  SearchResult,
  SourceHighlight,
} from "./types";

import { cloneState, makeId, nowIso, withAuditEvent, withAiRunEvent, formatSearchTraceSourceLabel } from "./utils";
import { formatSearchBriefSourceLabel, buildSearchBriefSourceEvidence, pickSearchBriefText, sanitizeExternalMaterialText, sanitizeExternalMaterialList, sanitizeExternalSource, withGeneratedArtifactWorkflowRun } from "./engine";

import { withMemoryCandidateReview } from "./memoryReview";

function buildDefaultSearchBriefSourceTrace(input: SearchBriefInput): SearchBriefSourceTrace[] {
  const sources = input.sources.filter((source) => source.id.trim());
  if (sources.length === 0) {
    return [];
  }

  return getSearchBriefClaims(input).map((item, index) => {
    const linkedSources = pickTraceSources(sources, index);
    return {
      id: makeId("source-trace"),
      claimType: item.claimType,
      claim: item.claim,
      sourceIds: linkedSources.map((source) => source.id),
      sourceLabels: linkedSources.map(formatSearchTraceSourceLabel)
    };
  });
}
export function buildProactiveSearchAgenda(state: ProductState): SearchAgendaItem[] {
  const theme = state.themes[0];
  const debt = state.debts.find((item) => item.status === "待了解") ?? state.debts[0];
  const decision = state.decisions[0];
  const confirmedMemory = state.memoryRecords.find((record) => record.status === "confirmed");
  // 没有任何真实认知资产(主题/知识债/决策/已确认记忆)时返回空议程,不再用 profile + 硬编码示例
  // (如"短期失控的可承受边界""下一步产品判断")硬造 4 条。否则空状态/新用户一进"外部调研",前端
  // "打开即更新"(App.tsx)就自动触发 4 条 bailian 联网搜索:查的是硬编码示例而非用户内容(无意义)、
  // 产 4 条占位简报污染空状态、又因串行联网把后端拖垮(reset/turn 卡满)。有真实资产后才主动调研。
  if (!theme && !debt && !decision && !confirmedMemory) {
    return [];
  }
  // SR-P1-02: only emit agenda items backed by real seed assets — no hardcoded
  // non-user placeholder queries ("短期失控的可承受边界" / "下一步产品判断").
  const agenda: SearchAgendaItem[] = [];
  if (theme?.name) {
    agenda.push({
      id: `search-agenda-hotspot-${slugifyAgendaQuery(theme.name)}`,
      query: `${theme.name} × AI 产品商业化热点`,
      source: "长期主题 + 热点",
      reason: "把当前反复主题放进外部趋势里，但仍回到用户自己的具体事件。",
      intent: "hotspot",
      seedAssetIds: [theme.id]
    });
  }
  if (debt?.concept) {
    agenda.push({
      id: `search-agenda-debt-${slugifyAgendaQuery(debt.concept)}`,
      query: `${debt.concept} 的最新讨论`,
      source: "知识债",
      reason: "把未完成概念转成可带入专访的问题素材。",
      intent: "knowledge-refresh",
      seedAssetIds: [debt.id]
    });
  }
  if (decision?.title) {
    agenda.push({
      id: `search-agenda-counterpoint-${slugifyAgendaQuery(decision.title)}`,
      query: `${decision.title} 的反方观点`,
      source: "决策校验",
      reason: "主动收集反方材料，避免下一场专访只强化既有判断。",
      intent: "counterpoint",
      seedAssetIds: [decision.id]
    });
  }
  if (confirmedMemory?.text) {
    const memorySignal =
      confirmedMemory.text.match(/授权|救火|控制感|组织惯性|放权/)?.[0] ??
      confirmedMemory.text.slice(0, 24);
    agenda.push({
      id: `search-agenda-memory-${slugifyAgendaQuery(memorySignal)}`,
      query: `${memorySignal} 的外部案例与可验证边界`,
      source: "长期记忆交叉验证",
      reason: "用外部案例校验已确认记忆，避免长期叙事只在内部循环。",
      intent: "memory-cross-check",
      seedAssetIds: [confirmedMemory.id]
    });
  }

  return dedupeSearchAgenda(agenda).slice(0, 4);
}
export function buildSearchBrief(
  state: ProductState,
  topic: string,
  provider: SearchProviderId = state.systemConfig.search.activeProvider,
  options: { agendaTrace?: SearchBriefAgendaTrace } = {}
): { brief: SearchBrief; nextState: ProductState } {
  const normalizedTopic = topic.trim() || "本周值得讨论的 AI 产品变化";
  const sources = createDemoSources(normalizedTopic, provider, state.systemConfig.search.maxSources);
  return createSearchBriefFromInput(state, {
    topic: normalizedTopic,
    provider,
    // ponytail: buildSearchBrief is always the offline template path (no live web
    // sources). Mark it needs-review so the UI never shows fabricated content as a
    // confirmed "ready" brief, and prefix the summary so the placeholder nature
    // propagates anywhere this text flows (knowledge debt / memory candidate).
    status: "needs-review",
    summary: `【示例数据·未联网】${normalizedTopic} 可作为专访的外部参照线索，但本条为离线占位内容，需配置搜索 provider 后刷新获取真实资料，且始终以用户自己的具体经验为准。`,
    facts: [
      `${normalizedTopic} 已经进入可讨论的业务流程层面，而不只是工具热闹。`,
      "外部资料只能作为追问线索，需要回到用户自己的具体事件里验证。",
      `本轮最多保留 ${state.systemConfig.search.maxSources} 个来源，避免专访被素材淹没。`
    ],
    controversies: [
      "争议：AI 产品商业化应该先看效率指标，还是先看组织是否愿意改变判断方式。",
      "争议：热点可能帮助用户看清问题，也可能成为逃避个人真实张力的借口。"
    ],
    opposingViews: [
      "反方观点：外部趋势不一定适用于用户当前行业和团队阶段。",
      "反方观点：如果没有可复盘行动，素材越多反而越容易稀释判断。"
    ],
    interviewAngles: [
      `专访角度：${normalizedTopic} 和用户最近的真实选择有什么关系？`,
      "专访角度：追一个具体项目，而不是泛泛讨论行业趋势。"
    ],
    discussionTopics: [
      `专访切入：${normalizedTopic} 对你当前判断的真实影响是什么？`,
      "哪些外部说法只是热闹，哪些能解释你最近的具体困境？",
      "如果把外部趋势落到一个项目决策上，最小验证动作是什么？"
    ],
    sourceAngles: [
      "外部趋势可能正在放大你对授权、风险和产品节奏的矛盾。",
      "不要把热点直接当结论，先追问它与你自己的历史原话是否互相印证。",
      "素材只提供角度，最终资产仍以用户确认和专访证据为准。"
    ],
    sources,
    ...(options.agendaTrace ? { agendaTrace: options.agendaTrace } : {})
  });
}
function createDemoSources(topic: string, provider: SearchProviderId, maxSources: number): SourceHighlight[] {
  const sourceTemplates = [
    {
      publisher: provider === "anysearch" ? "AnySearch" : "Local Signals",
      suffix: "行业讨论",
      snippet: "多个团队开始把 AI 工具从演示型能力转向可衡量的业务流程改造。"
    },
    {
      publisher: "Product Ops Review",
      suffix: "商业化观察",
      snippet: "真正有效的 AI 产品通常先改变工作流，再进入规模化获客。"
    },
    {
      publisher: "Founder Interview Notes",
      suffix: "创始人访谈",
      snippet: "受访者反复提到：AI 产品落地的关键不是模型参数，而是组织是否愿意改变判断方式。"
    },
    {
      publisher: "Research Digest",
      suffix: "研究摘录",
      snippet: "用户信任来自可解释的引用、边界和复盘机制。"
    },
    {
      publisher: "Market Watch",
      suffix: "市场快照",
      snippet: "热点信息需要经过来源可信度、相关度和可行动性过滤。"
    }
  ];

  return sourceTemplates.slice(0, Math.max(3, Math.min(maxSources, sourceTemplates.length))).map((template, index) => ({
    id: makeId(`source-${index + 1}`),
    title: `${topic}：${template.suffix}`,
    url: `https://example.local/${provider}/${encodeURIComponent(topic)}/${index + 1}`,
    publisher: template.publisher,
    publishedAt: new Date(Date.UTC(2026, 5, Math.max(1, 10 - index))).toISOString(),
    snippet: template.snippet,
    relevanceScore: 0.94 - index * 0.07,
    usage: index === 0 ? "topic-suggestion" : index === 1 ? "interview-context" : "post-note-reference"
  }));
}
export function createKnowledgeDebtFromSearchBrief(
  state: ProductState,
  briefId: string
): { debt: KnowledgeDebt; nextState: ProductState } | null {
  const brief = state.searchBriefs.find((item) => item.id === briefId);
  if (!brief) {
    return null;
  }

  const createdAt = nowIso();
  const sourceLabel = formatSearchBriefSourceLabel(brief);
  const debt: KnowledgeDebt = {
    id: makeId("debt"),
    concept: `${brief.topic} 的待验证知识债`,
    context: `外部资料（来源：${sourceLabel}）：${pickSearchBriefText(
      [brief.summary, ...brief.sourceAngles],
      "外部资料指出该主题值得进一步核验，但仍需要回到用户自己的具体事件。"
    )}`,
    whyImportant: `用于下一次专访校验：${pickSearchBriefText(
      [...brief.facts, ...brief.controversies],
      "该素材可能影响用户的产品判断、团队分工或长期主题。"
    )}`,
    status: "待了解",
    nextQuestion: pickSearchBriefText(
      [...brief.discussionTopics, ...brief.interviewAngles],
      `${brief.topic} 对你当前判断的真实影响是什么？`
    ),
    updatedAt: createdAt
  };

  const nextState = withAuditEvent(
    withExternalMaterialMemoryCandidate({
      ...cloneState(state),
      debts: [debt, ...state.debts]
    }, brief, createdAt),
    {
      type: "search_brief_asset_created",
      label: "搜索简报已转为知识债",
      detail: `从搜索简报“${brief.topic}”生成知识债：${debt.concept}`,
      severity: "info",
      entityType: "search_brief",
      entityId: brief.id,
      createdAt
    }
  );

  return { debt, nextState };
}
export function createPointFromSearchBrief(
  state: ProductState,
  briefId: string
): { point: PointAsset; nextState: ProductState } | null {
  const brief = state.searchBriefs.find((item) => item.id === briefId);
  if (!brief) {
    return null;
  }

  const createdAt = nowIso();
  const sourceLabel = formatSearchBriefSourceLabel(brief);
  const relatedThemeIds = resolveSearchBriefThemeIds(state, brief);
  const point: PointAsset = {
    id: makeId("point"),
    title: `反方观点：${brief.topic}`,
    content: `外部观点（来源：${sourceLabel}）：${pickSearchBriefText(
      [...brief.opposingViews, ...brief.controversies],
      "外部材料提供了一个需要在专访中被挑战和核验的反方观点。"
    )}`,
    status: "被挑战中",
    confidence: "待验证",
    evidence: [
      ...buildSearchBriefSourceEvidence(brief),
      ...brief.opposingViews.slice(0, 2).map((item) => `外部反方：${item}`),
      ...brief.controversies.slice(0, 1).map((item) => `外部争议：${item}`)
    ],
    relatedThemeIds,
    important: false,
    updatedAt: createdAt
  };

  const nextState = withAuditEvent(
    withExternalMaterialMemoryCandidate({
      ...cloneState(state),
      points: [point, ...state.points]
    }, brief, createdAt),
    {
      type: "search_brief_asset_created",
      label: "搜索简报已转为反方观点",
      detail: `从搜索简报“${brief.topic}”生成反方观点：${point.title}`,
      severity: "info",
      entityType: "search_brief",
      entityId: brief.id,
      createdAt
    }
  );

  return { point, nextState };
}
export function createQuestionFromSearchBrief(
  state: ProductState,
  briefId: string
): { question: QuestionAsset; nextState: ProductState } | null {
  const brief = state.searchBriefs.find((item) => item.id === briefId);
  if (!brief) {
    return null;
  }

  const createdAt = nowIso();
  const sourceLabel = formatSearchBriefSourceLabel(brief);
  const question: QuestionAsset = {
    id: makeId("question"),
    question: pickSearchBriefText(
      [...brief.discussionTopics, ...brief.interviewAngles],
      `${brief.topic} 对你当前判断的真实影响是什么？`
    ),
    whyImportant: `外部资料（来源：${sourceLabel}）：${pickSearchBriefText(
      [brief.summary, ...brief.facts],
      "该搜索素材适合转成下次专访回访点，但需要回到用户自己的具体事件。"
    )}`,
    status: "开放",
    appearances: 1,
    relatedThemeIds: resolveSearchBriefThemeIds(state, brief),
    nextPrompt: pickSearchBriefText(
      [...brief.interviewAngles, ...brief.sourceAngles],
      `下一次专访把“${brief.topic}”落到一个具体项目、一次冲突或一个选择上。`
    ),
    important: true,
    updatedAt: createdAt
  };

  const nextState = withAuditEvent(
    withExternalMaterialMemoryCandidate({
      ...cloneState(state),
      questions: [question, ...state.questions]
    }, brief, createdAt),
    {
      type: "search_brief_asset_created",
      label: "搜索简报已转为回访问题",
      detail: `从搜索简报“${brief.topic}”生成回访问题：${question.question}`,
      severity: "info",
      entityType: "search_brief",
      entityId: brief.id,
      createdAt
    }
  );

  return { question, nextState };
}

/** 审计修复(F1):外部 provider 文本字段的统一清洗口径——此前只有创建路径清洗,refresh/auto-run
 *  直接 spread 落库,注入纵深不一致。create 与 refresh 两条路径共用本函数。 */
export function sanitizeSearchBriefInputFields(input: SearchBriefInput): SearchBriefInput {
  return {
    ...input,
    summary: sanitizeExternalMaterialText(input.summary, "外部资料摘要已清洗，需回到原始来源核验。"),
    facts: sanitizeExternalMaterialList(input.facts, "外部资料事实已清洗，需回到原始来源核验。"),
    controversies: sanitizeExternalMaterialList(input.controversies, "外部争议观点已清洗，需回到原始来源核验。"),
    opposingViews: sanitizeExternalMaterialList(input.opposingViews, "外部反方观点已清洗，需回到原始来源核验。"),
    interviewAngles: sanitizeExternalMaterialList(input.interviewAngles, "外部专访角度已清洗，需回到用户具体事件验证。"),
    discussionTopics: sanitizeExternalMaterialList(input.discussionTopics, "外部讨论主题已清洗，需回到用户具体事件验证。"),
    sourceAngles: sanitizeExternalMaterialList(input.sourceAngles, "外部素材角度已清洗，需回到用户具体事件验证。"),
    sources: input.sources.map(sanitizeExternalSource)
  };
}

export function createSearchBriefFromInput(
  state: ProductState,
  input: SearchBriefInput
): { brief: SearchBrief; nextState: ProductState } {
  const createdAt = nowIso();
  const sanitizedInputWithoutTrace: SearchBriefInput = sanitizeSearchBriefInputFields(input);
  const sanitizedInput: SearchBriefInput = {
    ...sanitizedInputWithoutTrace,
    sourceTrace: normalizeSearchBriefSourceTrace(input.sourceTrace, sanitizedInputWithoutTrace)
  };
  const brief: SearchBrief = {
    ...sanitizedInput,
    topic: sanitizedInput.topic.trim() || "本周值得讨论的 AI 产品变化",
    status: sanitizedInput.status,
    sourceTrace: sanitizedInput.sourceTrace ?? [],
    appliedToSessionIds: [],
    createdAt,
    id: makeId("search-brief")
  };
  const stateWithCreationEvents = withAiRunEvent(
    withAuditEvent(
      {
        ...cloneState(state),
        searchBriefs: [brief, ...state.searchBriefs]
      },
      {
        type: "search_brief_created",
        label: "搜索简报已生成",
        detail: `主题“${brief.topic}”由 ${brief.provider} 生成，保留 ${brief.sources.length} 个来源。`,
        severity: brief.status === "ready" ? "info" : "warning",
        entityType: "search_brief",
        entityId: brief.id,
        createdAt
      }
    ),
    {
      workflow: "search_brief_generation",
      providerId: brief.provider,
      status: brief.status === "ready" ? "succeeded" : "degraded",
      entityType: "search_brief",
      entityId: brief.id,
      inputSummary: `搜索主题：${brief.topic}`,
      outputSummary: `生成 ${brief.facts.length} 条事实、${brief.sources.length} 个来源。`,
      estimatedTokens: Math.max(brief.summary.length, 1),
      degradedReason: brief.status === "ready" ? undefined : "搜索简报需要人工复核或来自降级 provider。",
      createdAt
    }
  );
  const nextState = withGeneratedArtifactWorkflowRun(stateWithCreationEvents, {
    workflow: "search_brief_generation",
    entityType: "search_brief",
    entityId: brief.id,
    inputSummary: `搜索主题：${brief.topic}`
  });

  return {
    brief,
    nextState
  };
}
function dedupeSearchAgenda(items: SearchAgendaItem[]) {
  const seenQueries = new Set<string>();
  return items.filter((item) => {
    const queryKey = item.query.trim();
    if (!queryKey || seenQueries.has(queryKey)) {
      return false;
    }
    seenQueries.add(queryKey);
    return true;
  });
}
function getSearchBriefClaims(input: SearchBriefInput): Array<{ claimType: SearchBriefClaimType; claim: string }> {
  return [
    ...input.facts.map((claim) => ({ claimType: "fact" as const, claim })),
    ...input.controversies.map((claim) => ({ claimType: "controversy" as const, claim })),
    ...input.opposingViews.map((claim) => ({ claimType: "opposing-view" as const, claim })),
    ...input.interviewAngles.map((claim) => ({ claimType: "interview-angle" as const, claim })),
    ...input.discussionTopics.map((claim) => ({ claimType: "discussion-topic" as const, claim })),
    ...input.sourceAngles.map((claim) => ({ claimType: "source-angle" as const, claim }))
  ].filter((item) => item.claim.trim().length > 0);
}
function normalizeSearchBriefSourceTrace(inputTrace: SearchBriefInput["sourceTrace"], input: SearchBriefInput): SearchBriefSourceTrace[] {
  const sources = input.sources.filter((source) => source.id.trim());
  if (sources.length === 0) {
    return [];
  }

  const sourceIds = new Set(sources.map((source) => source.id));
  const explicitTrace = Array.isArray(inputTrace)
    ? inputTrace
        .map((trace) => {
          const claim = sanitizeExternalMaterialText(trace.claim, "外部素材观点已清洗，需回到原始来源核验。");
          const linkedSources = trace.sourceIds
            .filter((sourceId) => sourceIds.has(sourceId))
            .map((sourceId) => sources.find((source) => source.id === sourceId))
            .filter((source): source is SourceHighlight => Boolean(source));
          if (!claim || linkedSources.length === 0) {
            return undefined;
          }
          return {
            id: trace.id || makeId("source-trace"),
            claimType: trace.claimType,
            claim,
            sourceIds: linkedSources.map((source) => source.id),
            sourceLabels: linkedSources.map(formatSearchTraceSourceLabel)
          } satisfies SearchBriefSourceTrace;
        })
        .filter((trace): trace is SearchBriefSourceTrace => Boolean(trace))
    : [];

  return explicitTrace.length > 0 ? explicitTrace : buildDefaultSearchBriefSourceTrace(input);
}
function pickTraceSources(sources: SourceHighlight[], claimIndex: number) {
  if (sources.length <= 1) {
    return sources;
  }
  const first = sources[claimIndex % sources.length];
  const second = sources[(claimIndex + 1) % sources.length];
  return [first, second].filter((source, index, items) => items.findIndex((item) => item.id === source.id) === index);
}
function resolveSearchBriefThemeIds(state: ProductState, brief: SearchBrief) {
  const corpus = [brief.topic, brief.summary, ...brief.discussionTopics, ...brief.interviewAngles].join(" ");
  const matched = state.themes
    .filter((theme) => {
      const summarySignal = theme.summary.trim().slice(0, 8);
      return corpus.includes(theme.name) || (summarySignal.length >= 4 && corpus.includes(summarySignal));
    })
    .map((theme) => theme.id);
  // ponytail: no match → leave the brief unclassified ([]), rather than force-attaching it
  // to themes[0]. Forcing首个主题 systematically pollutes that theme line with unrelated材料.
  return matched.length > 0 ? matched.slice(0, 2) : [];
}
function slugifyAgendaQuery(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "query";
}
function withExternalMaterialMemoryCandidate(state: ProductState, brief: SearchBrief, createdAt: string): ProductState {
  if (state.systemConfig.memory.externalMaterialMemoryPolicy !== "auto-candidate") {
    return state;
  }

  const existingCandidate = state.memoryCandidates.some(
    (candidate) => candidate.sourceType === "search_brief" && candidate.sourceId === brief.id
  );
  if (existingCandidate) {
    return state;
  }

  const candidate: MemoryCandidate = withMemoryCandidateReview({
    id: makeId("memory-candidate"),
    text: `用户正在把“${brief.topic}”作为专访外部素材，用来校验自己的产品判断、团队分工或长期主题。`,
    status: "pending",
    sourceType: "search_brief",
    sourceId: brief.id,
    evidenceQuote: pickSearchBriefText(
      [...brief.discussionTopics, ...brief.interviewAngles, brief.summary],
      `${brief.topic} 可作为专访外部素材。`
    ),
    reason: `外部素材“${brief.topic}”已被转成认知资产；根据当前记忆策略，只生成待审核候选，用户确认后才进入长期记忆。`,
    sensitivity: "normal",
    createdAt
  });

  return {
    ...state,
    memoryCandidates: [candidate, ...state.memoryCandidates]
  };
}
