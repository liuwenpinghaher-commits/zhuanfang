import { initialProductState } from "./seed";
import { withMemoryCandidateReview } from "./memoryReview";
import type {
  AiRunEvent,
  AuditEvent,
  AssetStatus,
  ConfigVersion,
  CognitiveRadar,
  CorpusImportInput,
  CorpusInsight,
  CorpusTurn,
  DualTrackNote,
  FinalizeResult,
  InterviewCard,
  InterviewContextPack,
  InterviewControlAction,
  InterviewDepth,
  InterviewEnginePolicy,
  InterviewFollowUpItem,
  InterviewGuide,
  InterviewGuideOptions,
  InterviewFeedbackInput,
  InterviewFeedbackTag,
  InterviewQualityReport,
  InterviewMode,
  InterviewResumeCard,
  InterviewSession,
  InterviewStrategyDecision,
  InterviewStrategyId,
  InterviewStrength,
  InterviewTransparencyItem,
  InterviewTurn,
  ImportSource,
  KnowledgeDebt,
  MemoryCandidate,
  MemoryEdge,
  MemoryGraphReference,
  MemoryGraphRelation,
  MemoryGraphTargetType,
  MemoryRecord,
  MonthlyReview,
  PlaybookPatch,
  PodcastEpisode,
  PointAsset,
  ProductState,
  QualityRemediationAction,
  QuestionAsset,
  RagChunk,
  ReadingAsset,
  QualityOperationsReport,
  ReferenceMaterialImportInput,
  RealtimeSignal,
  RealtimeSessionSignal,
  RealtimeTurnState,
  SearchAgendaItem,
  SearchBrief,
  SearchBriefAgendaTrace,
  SearchBriefClaimType,
  SearchBriefInput,
  SearchBriefSourceTrace,
  SearchProviderId,
  SearchResult,
  SourceHighlight,
  SystemConfig,
  SystemStatus,
  TriggerWorkflowRunInput,
  WorkflowRun,
  YearlyReview
} from "./types";

const modeLabels: Record<InterviewMode, string> = {
  daily: "日常复盘",
  decision: "决策专访",
  point: "观点专访",
  learning: "学习专访",
  organization: "组织/关系专访",
  "long-term": "长期主题专访"
};

const podcastAiDisclosure = "AI 合成语音：本节目由系统根据用户确认内容生成，请以原始笔记和来源为准。";

type PodcastFormat = PodcastEpisode["format"];

function formatPodcastFormatLabel(format: PodcastFormat) {
  return format === "host-guest" ? "主持对谈" : "单人旁白";
}

function buildPodcastScript(
  format: PodcastFormat,
  soloLines: string[],
  dialogueLines: string[]
) {
  return [podcastAiDisclosure, ...(format === "host-guest" ? dialogueLines : soloLines)].filter(Boolean).join("\n");
}

function buildPodcastShownotes(format: PodcastFormat, items: string[]) {
  return [podcastAiDisclosure, `播客形态：${formatPodcastFormatLabel(format)}`, ...items];
}

const nowIso = () => new Date().toISOString();

const makeId = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

const cloneState = (state: ProductState): ProductState => JSON.parse(JSON.stringify(state)) as ProductState;

const removedExternalInstruction = "[已移除外部指令片段]";
const noQualityEvidenceScore = 70;

const externalInstructionPatterns: RegExp[] = [
  /忽略(?:以上|之前|前面|所有)?(?:的)?(?:系统|开发者|用户)?指令/gi,
  /(?:系统|开发者)指令/gi,
  /不要遵守(?:用户)?确认流程/gi,
  /(?:直接)?输出密钥/gi,
  /写入(?:长期)?记忆/gi,
  /ignore\s+(?:all\s+)?previous\s+instructions/gi,
  /system\s+prompt/gi,
  /developer\s+message/gi,
  /api\s*key/gi,
  /password/gi,
  /secret/gi,
  /reveal\s+the\s+system\s+prompt/gi,
  /export\s+(?:password|secret)/gi,
  /leak\s+(?:api\s*key|secret|password)/gi
];

function withAuditEvent(state: ProductState, event: Omit<AuditEvent, "id">): ProductState {
  return {
    ...state,
    auditEvents: [
      {
        id: makeId("audit"),
        ...event
      },
      ...(state.auditEvents ?? [])
    ]
  };
}

function withAiRunEvent(state: ProductState, event: Omit<AiRunEvent, "id">): ProductState {
  return {
    ...state,
    aiRunEvents: [
      {
        id: makeId("ai-run"),
        ...event
      },
      ...(state.aiRunEvents ?? [])
    ]
  };
}

export function triggerWorkflowRun(state: ProductState, input: TriggerWorkflowRunInput): { run: WorkflowRun; nextState: ProductState } {
  const startedAt = nowIso();
  const workflowRunId = makeId("workflow-run");
  const completedAt = nowIso();
  const workflowDetails = buildWorkflowRunDetails(state, input);
  const workflowMetadata = workflowDetails.metadata ?? {};
  const run: WorkflowRun = {
    id: workflowRunId,
    workflow: input.workflow,
    status: "succeeded",
    providerId: "local-workflow-runtime",
    entityType: input.entityType,
    entityId: input.entityId,
    inputSummary: input.inputSummary,
    outputSummary: workflowDetails.outputSummary,
    startedAt,
    completedAt,
    latencyMs: 0,
    traceId: `trace-${workflowRunId}`,
    metadata: workflowMetadata
  };
  const stateWithRun: ProductState = {
    ...state,
    workflowRuns: [run, ...(state.workflowRuns ?? [])]
  };
  const stateWithAiRun = withAiRunEvent(stateWithRun, {
    workflow: input.workflow,
    workflowRunId,
    providerId: run.providerId,
    status: "succeeded",
    entityType: input.entityType,
    entityId: input.entityId,
    inputSummary: input.inputSummary,
    outputSummary: run.outputSummary,
    latencyMs: run.latencyMs,
    createdAt: completedAt
  });
  const securityInterceptionCount =
    input.workflow === "context_pack_build" && typeof workflowMetadata.securityInterceptionCount === "number"
      ? workflowMetadata.securityInterceptionCount
      : 0;
  const criticalSecurityInterceptionCount =
    input.workflow === "context_pack_build" && typeof workflowMetadata.criticalSecurityInterceptionCount === "number"
      ? workflowMetadata.criticalSecurityInterceptionCount
      : 0;
  const nextState =
    securityInterceptionCount > 0
      ? withAuditEvent(stateWithAiRun, {
          type: "context_security_intercepted",
          label: "ContextPack 安全拦截",
          detail: `构建模型上下文前拦截 ${securityInterceptionCount} 项风险，其中 ${criticalSecurityInterceptionCount} 项为 critical。`,
          severity: criticalSecurityInterceptionCount > 0 ? "critical" : "warning",
          entityType: input.entityType,
          entityId: input.entityId,
          createdAt: completedAt
        })
      : stateWithAiRun;

  return {
    run,
    nextState
  };
}

function withGeneratedArtifactWorkflowRun(state: ProductState, input: TriggerWorkflowRunInput): ProductState {
  return triggerWorkflowRun(state, input).nextState;
}

export function refreshWorkflowRunDetails(state: ProductState, input: TriggerWorkflowRunInput): ProductState {
  const existingRun = (state.workflowRuns ?? []).find(
    (run) => run.workflow === input.workflow && run.entityType === input.entityType && run.entityId === input.entityId
  );
  if (!existingRun) {
    return triggerWorkflowRun(state, input).nextState;
  }

  const completedAt = nowIso();
  const workflowDetails = buildWorkflowRunDetails(state, input);
  const refreshedRun: WorkflowRun = {
    ...existingRun,
    outputSummary: workflowDetails.outputSummary,
    completedAt,
    metadata: workflowDetails.metadata
  };

  return {
    ...state,
    workflowRuns: state.workflowRuns.map((run) => (run.id === existingRun.id ? refreshedRun : run)),
    aiRunEvents: state.aiRunEvents.map((event) =>
      event.workflowRunId === existingRun.id
        ? {
            ...event,
            outputSummary: workflowDetails.outputSummary
          }
        : event
    )
  };
}

function buildWorkflowRunDetails(
  state: ProductState,
  input: TriggerWorkflowRunInput
): Pick<WorkflowRun, "outputSummary" | "metadata"> {
  if (input.workflow === "context_pack_build") {
    const session =
      input.entityType === "interview_session" ? state.sessions.find((item) => item.id === input.entityId) : undefined;
    const topicHint = session?.guide.topicHint || session?.title || state.themes[0]?.name || state.profile.currentFocus;
    const contextPack = buildInterviewContextPack(state, {
      topicHint,
      ...(session?.card.searchBriefId ? { searchBriefId: session.card.searchBriefId } : {})
    });
    const metadata = {
      topicHint: contextPack.topicHint,
      confirmedMemoryCount: contextPack.confirmedMemories.length,
      memoryRecordCount: contextPack.memoryRecords.length,
      pendingCandidateCount: contextPack.pendingCandidates.length,
      correctionCount: contextPack.corrections.length,
      memoryEdgeCount: contextPack.memoryEdges.length,
      graphReferenceCount: contextPack.graphReferences.length,
      searchBriefCount: contextPack.searchBriefs.length,
      sourceHighlightCount: contextPack.sourceHighlights.length,
      ragChunkCount: contextPack.ragChunks.length,
      importSourceCount: contextPack.sources.filter((source) => source.type === "import_source").length,
      securityInterceptionCount: contextPack.securityInterceptions.length,
      criticalSecurityInterceptionCount: contextPack.securityInterceptions.filter(
        (interception) => interception.severity === "critical"
      ).length,
      sourceCount: contextPack.sources.length
    };

    return {
      outputSummary:
        `ContextPack 已构建：主题「${contextPack.topicHint}」，` +
        `${metadata.confirmedMemoryCount} 条确认记忆，${metadata.pendingCandidateCount} 条待审候选，` +
        `${metadata.memoryEdgeCount} 条记忆图谱边，${metadata.searchBriefCount} 份外部资料，${metadata.ragChunkCount} 个 RAG 分块，` +
        `${metadata.sourceCount} 个来源，${metadata.securityInterceptionCount} 项安全拦截。`,
      metadata
    };
  }

  if (input.workflow === "memory_projection") {
    const session =
      input.entityType === "interview_session" ? state.sessions.find((item) => item.id === input.entityId) : undefined;
    const topicHint = session?.guide.topicHint || state.themes[0]?.name || state.profile.currentFocus;
    const pendingCandidates = state.memoryCandidates.filter((candidate) => candidate.status === "pending");
    const confirmedRecords = state.memoryRecords.filter((record) => record.status === "confirmed");
    const deprecatedRecords = state.memoryRecords.filter((record) => record.status === "deprecated");
    const sensitiveCandidates = pendingCandidates.filter((candidate) => candidate.sensitivity === "sensitive");
    const contextPack = buildInterviewContextPack(state, { topicHint });
    const metadata = {
      topicHint: contextPack.topicHint,
      pendingCandidateCount: pendingCandidates.length,
      sensitiveCandidateCount: sensitiveCandidates.length,
      confirmedRecordCount: confirmedRecords.length,
      deprecatedRecordCount: deprecatedRecords.length,
      modelContextRecordCount: contextPack.memoryRecords.length
    };

    return {
      outputSummary:
        `MemoryProjection 已完成：${metadata.pendingCandidateCount} 条待审候选，` +
        `${metadata.confirmedRecordCount} 条确认长期记忆，${metadata.sensitiveCandidateCount} 条敏感候选。`,
      metadata
    };
  }

  if (input.workflow === "search_brief_generation") {
    const brief =
      input.entityType === "search_brief" ? state.searchBriefs.find((item) => item.id === input.entityId) : undefined;
    if (brief) {
      const metadata = {
        topic: brief.topic,
        provider: brief.provider,
        sourceCount: brief.sources.length,
        factCount: brief.facts.length,
        controversyCount: brief.controversies.length,
        discussionTopicCount: brief.discussionTopics.length,
        needsReview: brief.status === "needs-review"
      };

      return {
        outputSummary:
          `SearchBrief 已同步：主题「${brief.topic}」，${metadata.factCount} 条事实，` +
          `${metadata.sourceCount} 个来源，${metadata.discussionTopicCount} 个讨论主题。`,
        metadata
      };
    }
  }

  if (input.workflow === "podcast_generation") {
    const episode =
      input.entityType === "podcast_episode"
        ? state.podcastEpisodes.find((item) => item.id === input.entityId)
        : undefined;
    if (episode) {
      const metadata = {
        title: episode.title,
        sourceType: episode.sourceType ?? "note",
        voice: episode.voice,
        durationSec: episode.durationSec,
        chapterCount: episode.chapters.length,
        shownoteCount: episode.shownotes.length,
        scriptConfirmed: episode.scriptReviewStatus === "用户确认",
        audioRendered: episode.audioRenderStatus === "rendered"
      };

      return {
        outputSummary:
          `PodcastGeneration 已同步：${episode.title}，预计 ${episode.durationSec} 秒，` +
          `${metadata.chapterCount} 个章节，${metadata.shownoteCount} 条 shownotes。`,
        metadata
      };
    }
  }

  if (input.workflow === "import_ingestion") {
    const importSource =
      input.entityType === "import_source" ? state.importSources.find((item) => item.id === input.entityId) : undefined;
    if (importSource) {
      const chunkCount = importSource.chunkIds.length;
      const metadata = {
        title: importSource.title,
        sourceType: importSource.sourceType,
        chunkCount,
        searchBriefId: importSource.searchBriefId,
        sourceUrlConfigured: Boolean(importSource.sourceUrl),
        sensitivity: importSource.sensitivity
      };

      return {
        outputSummary:
          `ImportIngestion 已同步：${importSource.title}，${chunkCount} 个 RAG 分块，` +
          `资料包 ${importSource.searchBriefId} 可带入专访。`,
        metadata
      };
    }

    const corpusImport =
      input.entityType === "corpus_import" ? state.corpusImports.find((item) => item.id === input.entityId) : undefined;
    const insight = corpusImport ? state.corpusInsights.find((item) => item.importId === corpusImport.id) : undefined;
    if (corpusImport) {
      const metadata = {
        title: corpusImport.title,
        mediaType: corpusImport.mediaType,
        turnCount: corpusImport.turns.length,
        dimensionCount: insight?.dimensions.length ?? 0,
        patchCount: insight?.recommendedPatches.length ?? 0,
        sourceUrlConfigured: Boolean(corpusImport.sourceUrl)
      };

      return {
        outputSummary:
          `ImportIngestion 已同步：${corpusImport.title}，${metadata.turnCount} 个转写轮次，` +
          `${metadata.dimensionCount} 个分析维度，${metadata.patchCount} 个 PlaybookPatch。`,
        metadata
      };
    }
  }

  if (input.workflow === "reference_interview_learning") {
    const corpusImport =
      input.entityType === "corpus_import" ? state.corpusImports.find((item) => item.id === input.entityId) : undefined;
    const insight = corpusImport ? state.corpusInsights.find((item) => item.importId === corpusImport.id) : undefined;
    if (corpusImport && insight) {
      const patches = insight.recommendedPatches;
      const metadata = {
        title: corpusImport.title,
        mediaType: corpusImport.mediaType,
        turnCount: corpusImport.turns.length,
        dimensionCount: insight.dimensions.length,
        patchCount: patches.length,
        proposedPatchCount: patches.filter((patch) => patch.status === "proposed").length,
        appliedPatchCount: patches.filter((patch) => patch.status === "applied").length,
        revertedPatchCount: patches.filter((patch) => patch.status === "reverted").length,
        ruleCount: patches.reduce((count, patch) => count + patch.rules.length, 0)
      };

      return {
        outputSummary:
          `ReferenceInterviewLearning 已同步：${corpusImport.title}，${metadata.dimensionCount} 个分析维度，` +
          `${metadata.patchCount} 个 PlaybookPatch，${metadata.appliedPatchCount} 个已影响引擎。`,
        metadata
      };
    }
  }

  return {
    outputSummary: buildWorkflowOutputSummary(input.workflow),
    metadata: {
      runtime: "local-workflow-runtime"
    }
  };
}

function buildWorkflowOutputSummary(workflow: WorkflowRun["workflow"]) {
  const summaries: Record<WorkflowRun["workflow"], string> = {
    interview_preparation: "专访准备 workflow 已完成。",
    context_pack_build: "ContextPack 构建 workflow 已完成。",
    memory_projection: "长期记忆投影 workflow 已完成。",
    import_ingestion: "导入资料摄取 workflow 已完成。",
    search_brief_generation: "已完成联网素材生成 workflow run。",
    podcast_generation: "已完成播客生成 workflow run。",
    reference_interview_learning: "已完成专访样本学习 workflow run。"
  };
  return summaries[workflow];
}

interface CreateSessionOptions {
  searchBriefId?: string;
  topicHint?: string;
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

export function createInitialProductState(): ProductState {
  return cloneState(initialProductState);
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

export function buildInterviewEnginePolicy(state: ProductState): InterviewEnginePolicy {
  return {
    allowWebInInterview: state.systemConfig.search.allowWebInInterview,
    maxFollowUpDepth: state.systemConfig.interview.maxFollowUpDepth,
    silenceHoldMs: state.systemConfig.interview.silenceHoldMs,
    playbookVersion: state.systemConfig.interview.playbookVersion,
    appliedPlaybookRules: collectAppliedPlaybookRules(state),
    qualityGuardrails: buildQualityGuardrails(state),
    memory: { ...state.systemConfig.memory }
  };
}

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

type SemanticRagContext = {
  chunks: RagChunk[];
  sourceHighlights: SourceHighlight[];
  importSources: ImportSource[];
};

function emptySemanticRagContext(): SemanticRagContext {
  return {
    chunks: [],
    sourceHighlights: [],
    importSources: []
  };
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

function isImportSourceAllowedInContext(source: ImportSource, memoryPolicy: ProductState["systemConfig"]["memory"]) {
  return source.sensitivity !== "sensitive" || memoryPolicy.includeSensitiveMemoriesInContext;
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

function isModelSafeMemoryRecord(record: MemoryRecord) {
  return (record.sensitivity ?? "normal") !== "sensitive";
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

export function buildInterviewGuide(state: ProductState, options: InterviewGuideOptions = {}): InterviewGuide {
  const explicitTopicHint = options.topicHint?.trim();
  const searchBrief = resolveInterviewContextSearchBrief(state, options);
  const topTheme = state.themes.find((theme) => theme.name === "控制感") ?? state.themes[0];
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

function collectAppliedPlaybookRules(state: ProductState) {
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

function formatSearchAgendaTraceForInterview(trace: SearchBriefAgendaTrace) {
  const seedAssets = trace.seedAssetIds.length > 0 ? `；关联资产：${trace.seedAssetIds.join(" / ")}` : "";
  return `主动搜集依据（${formatSearchAgendaIntent(trace.intent)} · ${trace.source}）：${trace.reason}${seedAssets}`;
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

export function buildInterviewCard(state: ProductState, searchBriefId?: string, topicHint?: string): InterviewCard {
  const topTheme = state.themes.find((theme) => theme.name === "控制感") ?? state.themes[0];
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
    : !topTheme
      ? "重新开始一次专访"
    : topTheme.name === "控制感"
      ? "你对“救火”和放手的真实边界"
      : `继续追踪：${topTheme.name}`;
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

  return {
    title,
    whyNow: searchBrief
      ? agendaContext
        ? `你最近多次提到${themeName}，同时“${searchBrief.topic}”出现了可借用的外部素材。${agendaContext}，适合把个人问题放进更大的语境里看。`
        : `你最近多次提到${themeName}，同时“${searchBrief.topic}”出现了可借用的外部素材，适合把个人问题放进更大的语境里看。`
      : explicitTopicHint && hasContextSources
        ? `你刚选中的线索命中了可引用的导入资料，适合先借外部材料校准问题，再回到你的具体场景。`
      : explicitTopicHint
        ? `你刚在资产库中选中了这条线索，适合直接接上它继续专访，而不是回到泛泛复盘。`
        : focusQuestion
          ? `你在会后反馈里明确要求继续追问这个问题，适合直接接上上次的未完成线索。`
          : topTheme
            ? `你最近多次提到${topTheme.name}，但还没有把“最坏会发生什么”说具体。`
            : "当前没有长期主题和历史样例，适合从一个最近真实发生的场景重新建立专访上下文。",
    suggestedOpening: searchBrief
      ? `我们先从一个外部素材切入：${explicitTopicHint ?? searchBrief.discussionTopics[0]} 这和你最近说的“救火”有什么真实关系？`
      : explicitTopicHint && hasContextSources
        ? `我们先拿这条导入资料做参照：${ensureSentenceEnd(explicitTopicHint)}它和你最近的真实场景有什么关系？`
      : guide.suggestedOpening,
    historyReferences: Array.from(new Set([...(agendaContext ? [agendaContext] : []), ...sourceReferences, reference, ...confirmedMemoryTexts])).slice(0, 4),
    potentialTension: searchBrief?.sourceAngles[0] ?? contextPack.ragChunks[0]?.text ?? "你一边想授权，一边又担心放手之后项目失控。",
    suggestedPerspectives: guide.recommendedPerspectives,
    likelyOutputs: [
      "一个更准确的长期问题",
      "一条关于授权边界的观点",
      openDebt ? `知识债回访：${openDebt.concept}` : "一个新的知识债候选",
      ...(hasContextSources ? [`素材引用：${contextSourceHighlights[0]?.title}`] : [])
    ],
    searchBriefId: searchBrief?.id,
    sourceHighlights: hasContextSources ? contextSourceHighlights : undefined
  };
}

function formatRagChunkSourceLabel(state: ProductState, chunk: RagChunk) {
  const source = state.importSources.find((item) => item.id === chunk.sourceId);
  const sourceUrl = chunk.sourceUrl ?? source?.sourceUrl;
  return sourceUrl ? getReferenceMaterialPublisher(sourceUrl) : source?.title ?? "导入资料";
}

function isSearchBriefDiscussionTopic(searchBrief: SearchBrief | undefined, topicHint: string | undefined) {
  if (!searchBrief || !topicHint) {
    return false;
  }
  return searchBrief.topic === topicHint || searchBrief.discussionTopics.some((topic) => topic === topicHint);
}

function findNextInterviewFocusQuestion(state: ProductState) {
  return state.questions.find(
    (question) =>
      question.status === "正在聚焦" &&
      question.important &&
      question.whyImportant.includes("会后反馈")
  );
}

function formatQuestionTitle(question: string) {
  return question.replace(/^下次继续追问/, "").replace(/[。！？!?]+$/g, "").trim() || question;
}

function ensureSentenceEnd(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  return /[。！？!?]$/.test(trimmed) ? trimmed : `${trimmed}。`;
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

function getSessionLastUpdatedAt(session: InterviewSession) {
  return session.turns.at(-1)?.timestamp ?? session.startedAt;
}

function findLastTurn(session: InterviewSession, role: InterviewTurn["role"]) {
  for (let index = session.turns.length - 1; index >= 0; index -= 1) {
    if (session.turns[index].role === role) {
      return session.turns[index];
    }
  }
  return undefined;
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

function formatQuestionFollowUpTitle(question: ProductState["questions"][number]) {
  return isUserRequestedFollowUpQuestion(question) ? `用户标记：${formatQuestionTitle(question.question)}` : question.question;
}

function scoreQuestionFollowUp(question: ProductState["questions"][number]) {
  const statusScore = question.status === "正在聚焦" ? 78 : question.status === "反复出现" ? 68 : 56;
  const importanceScore = question.important ? 12 : 0;
  const appearanceScore = Math.min(12, question.appearances * 3);
  const feedbackScore = isUserRequestedFollowUpQuestion(question) ? 25 : 0;
  return Math.min(100, statusScore + importanceScore + appearanceScore + feedbackScore);
}

function isUserRequestedFollowUpQuestion(question: ProductState["questions"][number]) {
  return question.whyImportant.includes("会后反馈") || question.question.startsWith("下次继续追问");
}

function scoreDebtFollowUp(debt: ProductState["debts"][number]) {
  const staleDays = daysBetween(debt.updatedAt, nowIso());
  return Math.min(88, 70 + Math.min(12, staleDays) + (debt.whyImportant.includes("授权") ? 6 : 0));
}

function buildDecisionReviewPrompt(decision: ProductState["decisions"][number]) {
  return `复盘决策“${decision.title}”：当时的选择是否降低了短期风险，还是继续强化了等待拍板？`;
}

function scoreDecisionFollowUp(decision: ProductState["decisions"][number]) {
  const daysUntilReview = daysBetween(nowIso(), decision.reviewAt);
  const dueScore = daysUntilReview <= 0 ? 20 : daysUntilReview <= 7 ? 14 : 6;
  return Math.min(92, 72 + dueScore + (decision.decisionKind === "用户决策" ? 6 : 0));
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

function normalizeFollowUpPrompt(prompt: string) {
  return prompt.replace(/\s+/g, "").replace(/[。！？!?]+$/g, "");
}

function resolveInterviewSearchBrief(state: ProductState, searchBriefId?: string) {
  if (!state.systemConfig.search.allowWebInInterview) {
    return undefined;
  }
  const brief = searchBriefId ? state.searchBriefs.find((item) => item.id === searchBriefId) : state.searchBriefs[0];
  return brief && isSearchBriefAllowedInInterviewContext(state, brief) ? brief : undefined;
}

function resolveInterviewContextSearchBrief(state: ProductState, options: InterviewGuideOptions = {}) {
  const explicitTopicHint = options.topicHint?.trim();
  const requestedSearchBrief = resolveInterviewSearchBrief(state, options.searchBriefId);
  if (explicitTopicHint && !isSearchBriefDiscussionTopic(requestedSearchBrief, explicitTopicHint)) {
    return undefined;
  }
  return requestedSearchBrief;
}

function isSearchBriefAllowedInInterviewContext(state: ProductState, brief: SearchBrief) {
  const linkedImportSource = state.importSources.find((source) => source.searchBriefId === brief.id);
  if (!linkedImportSource) {
    return true;
  }
  return linkedImportSource.sensitivity !== "sensitive" || state.systemConfig.memory.includeSensitiveMemoriesInContext;
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

function countOccurrences(text: string, signal: string) {
  return text.split(signal).length - 1;
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

type MemoryGraphTargetCandidate = {
  targetType: MemoryGraphTargetType;
  targetId: string;
  targetLabel: string;
  relation: MemoryGraphRelation;
  corpus: string;
};

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

function buildMemoryEdgesForRecord(state: ProductState, record: MemoryRecord, createdAt: string): MemoryEdge[] {
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

function tokenizeMemoryGraphText(text: string) {
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

function addMemoryGraphToken(tokens: Set<string>, token: string) {
  const normalized = token.trim().toLowerCase();
  if (normalized.length < 2 || memoryGraphStopTokens.has(normalized)) {
    return;
  }
  tokens.add(normalized);
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

function hasMemoryGraphTokenOverlap(left: Set<string>, right: Set<string>) {
  for (const token of left) {
    if (right.has(token)) {
      return true;
    }
  }
  return false;
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

function buildMemoryEdgeLabel(relation: MemoryGraphRelation, targetLabel: string) {
  return `${getMemoryGraphRelationLabel(relation)}：${targetLabel}`;
}

function getMemoryGraphRelationLabel(relation: MemoryGraphRelation) {
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

function formatMemoryGraphTargetLabel(text: string) {
  return text.length > 28 ? `${text.slice(0, 28)}...` : text;
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

function formatExternalMaterial(label: "外部资料" | "外部观点", searchBrief: SearchBrief, text: string) {
  return `${label}（来源：${getSearchSourceLabelForClaim(searchBrief, text)}）：${text}`;
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

function getPrimarySearchSourceLabel(searchBrief: SearchBrief) {
  return searchBrief.sources[0]?.publisher || searchBrief.provider;
}

function sanitizeExternalMaterialText(text: string, fallback: string) {
  let sanitized = text.trim();
  for (const pattern of externalInstructionPatterns) {
    sanitized = sanitized.replace(pattern, removedExternalInstruction);
  }
  sanitized = sanitized
    .replace(new RegExp(`(?:${escapeRegExp(removedExternalInstruction)}\\s*){2,}`, "g"), `${removedExternalInstruction} `)
    .replace(/\s+/g, " ")
    .trim();
  return sanitized || fallback;
}

function sanitizeExternalMaterialBlock(text: string, fallback: string) {
  const lines = text
    .split(/\n+/)
    .map((line) => sanitizeExternalMaterialText(line, fallback))
    .filter(Boolean);
  return lines.length > 0 ? lines.join("\n") : fallback;
}

function sanitizeExternalMaterialList(items: string[], fallback: string) {
  return items.map((item) => sanitizeExternalMaterialText(item, fallback)).filter(Boolean);
}

function sanitizeExternalSource(source: SourceHighlight): SourceHighlight {
  return {
    ...source,
    title: sanitizeExternalMaterialText(source.title, "已清洗的外部资料标题"),
    publisher: sanitizeExternalMaterialText(source.publisher, "来源待确认"),
    snippet: sanitizeExternalMaterialText(source.snippet, "外部资料片段已清洗，需回到原始来源核验。")
  };
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

function pickTraceSources(sources: SourceHighlight[], claimIndex: number) {
  if (sources.length <= 1) {
    return sources;
  }
  const first = sources[claimIndex % sources.length];
  const second = sources[(claimIndex + 1) % sources.length];
  return [first, second].filter((source, index, items) => items.findIndex((item) => item.id === source.id) === index);
}

function formatSearchTraceSourceLabel(source: SourceHighlight) {
  return `${source.publisher}｜${source.title}`;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function daysBetween(startIso: string, endIso: string) {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return 0;
  }
  return Math.max(0, Math.floor((end - start) / 86_400_000));
}

export function buildProactiveSearchAgenda(state: ProductState): SearchAgendaItem[] {
  const theme = state.themes[0];
  const debt = state.debts.find((item) => item.status === "待了解") ?? state.debts[0];
  const decision = state.decisions[0];
  const confirmedMemory = state.memoryRecords.find((record) => record.status === "confirmed");
  const themeQuery = theme?.name ?? state.profile.currentFocus;
  const debtQuery = debt?.concept ?? "短期失控的可承受边界";
  const decisionQuery = decision?.title ?? "下一步产品判断";
  const memorySignal = confirmedMemory?.text.match(/授权|救火|控制感|组织惯性/)?.[0] ?? themeQuery;

  const agenda: SearchAgendaItem[] = [
    {
      id: `search-agenda-hotspot-${slugifyAgendaQuery(themeQuery)}`,
      query: `${themeQuery} × AI 产品商业化热点`,
      source: "长期主题 + 热点",
      reason: "把当前反复主题放进外部趋势里，但仍回到用户自己的具体事件。",
      intent: "hotspot",
      seedAssetIds: theme ? [theme.id] : ["profile"]
    },
    {
      id: `search-agenda-debt-${slugifyAgendaQuery(debtQuery)}`,
      query: `${debtQuery} 的最新讨论`,
      source: "知识债",
      reason: "把未完成概念转成可带入专访的问题素材。",
      intent: "knowledge-refresh",
      seedAssetIds: debt ? [debt.id] : []
    },
    {
      id: `search-agenda-counterpoint-${slugifyAgendaQuery(decisionQuery)}`,
      query: `${decisionQuery} 的反方观点`,
      source: "决策校验",
      reason: "主动收集反方材料，避免下一场专访只强化既有判断。",
      intent: "counterpoint",
      seedAssetIds: decision ? [decision.id] : []
    },
    {
      id: `search-agenda-memory-${slugifyAgendaQuery(memorySignal)}`,
      query: `${memorySignal} 的外部案例与可验证边界`,
      source: "长期记忆交叉验证",
      reason: "用外部案例校验已确认记忆，避免长期叙事只在内部循环。",
      intent: "memory-cross-check",
      seedAssetIds: confirmedMemory ? [confirmedMemory.id] : []
    }
  ];

  return dedupeSearchAgenda(agenda).slice(0, 4);
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

function slugifyAgendaQuery(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "query";
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
    status: provider === "local-demo" ? "ready" : "needs-review",
    summary: `${normalizedTopic} 正在影响用户的产品判断、团队分工和长期主题，适合在专访里作为外部参照，而不是替代个人经验。`,
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

export function createSearchBriefFromInput(
  state: ProductState,
  input: SearchBriefInput
): { brief: SearchBrief; nextState: ProductState } {
  const createdAt = nowIso();
  const sanitizedInputWithoutTrace: SearchBriefInput = {
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

export function importReferenceMaterial(
  state: ProductState,
  input: ReferenceMaterialImportInput
): { source: ImportSource; chunks: RagChunk[]; brief: SearchBrief; nextState: ProductState } {
  const createdAt = nowIso();
  const title = sanitizeExternalMaterialText(input.title, "导入资料").trim() || "导入资料";
  const content = sanitizeExternalMaterialBlock(input.content, `${title} 的资料内容待补充。`);
  const chunkTexts = chunkReferenceMaterial(content);
  const sourceId = makeId("import-source");
  const chunks: RagChunk[] = chunkTexts.map((text, index) => ({
    id: makeId("rag-chunk"),
    sourceId,
    title: `${title} · 片段 ${index + 1}`,
    text,
    keywords: extractReferenceMaterialKeywords(`${title} ${text}`),
    tokenEstimate: Math.max(1, Math.ceil(text.length / 4)),
    sourceUrl: input.sourceUrl,
    usage: "interview-context",
    createdAt
  }));

  const sourceUrl = input.sourceUrl?.trim();
  const publisher = sourceUrl ? getReferenceMaterialPublisher(sourceUrl) : "手动导入";
  const sources = chunks.slice(0, Math.max(1, state.systemConfig.search.maxSources)).map((chunk, index): SourceHighlight => ({
    id: makeId(`import-source-${index + 1}`),
    title: chunk.title,
    url: sourceUrl || `local-import://${sourceId}/${chunk.id}`,
    publisher,
    publishedAt: createdAt,
    snippet: chunk.text,
    relevanceScore: Math.max(0.55, 0.95 - index * 0.08),
    usage: "interview-context"
  }));
  const summary = buildReferenceMaterialSummary(title, chunks);
  const briefInput: SearchBriefInput = {
    topic: title,
    provider: "local-demo",
    status: "ready",
    summary,
    facts: chunks.slice(0, 3).map((chunk) => `导入资料片段：${chunk.text}`),
    controversies: [
      "待复核：这份资料的判断需要回到用户自己的具体经历验证。",
      "待复核：资料里的通用结论不应直接写入长期记忆。"
    ],
    opposingViews: [
      "反方校验：资料观点可能只适合特定组织阶段，不一定适用于当前团队。",
      "反方校验：如果没有具体项目证据，外部资料可能会稀释真实问题。"
    ],
    interviewAngles: [
      `专访角度：这份《${title}》如何改变你对当前问题的判断？`,
      "专访角度：先找一个具体项目，验证资料观点是否真的解释了当下困境。"
    ],
    discussionTopics: [
      `专访切入：${title} 对你当前判断的真实影响是什么？`,
      `这份资料里哪一句最像你最近遇到的具体场景？`,
      "如果把这份资料转成一个低成本验证动作，下一步是什么？"
    ],
    sourceAngles: chunks.slice(0, 3).map((chunk) => `资料片段：${chunk.text}`),
    sources
  };
  const brief: SearchBrief = {
    ...briefInput,
    id: makeId("search-brief"),
    sourceTrace: buildDefaultSearchBriefSourceTrace(briefInput),
    appliedToSessionIds: [],
    createdAt
  };
  const source: ImportSource = {
    id: sourceId,
    title,
    sourceType: input.sourceType,
    sourceUrl: sourceUrl || undefined,
    content,
    status: "chunked",
    sensitivity: input.sensitivity === "sensitive" ? "sensitive" : "normal",
    searchBriefId: brief.id,
    chunkIds: chunks.map((chunk) => chunk.id),
    createdAt,
    updatedAt: createdAt
  };

  const importedState = withReferenceMaterialMemoryCandidate({
    ...cloneState(state),
    importSources: [source, ...state.importSources],
    ragChunks: [...chunks, ...state.ragChunks],
    searchBriefs: [brief, ...state.searchBriefs]
  }, source, chunks, createdAt);
  const stateWithEvents = withAiRunEvent(
    withAuditEvent(importedState, {
      type: "reference_material_imported",
      label: "导入资料已入库",
      detail: `《${source.title}》已生成 ${chunks.length} 个 RAG 分块和 1 份可带入专访的资料包。`,
      severity: source.sensitivity === "sensitive" ? "warning" : "info",
      entityType: "import_source",
      entityId: source.id,
      createdAt
    }),
    {
      workflow: "import_ingestion",
      providerId: "deterministic-engine",
      status: "succeeded",
      entityType: "import_source",
      entityId: source.id,
      inputSummary: `${source.sourceType} 资料：${source.title}`,
      outputSummary: `生成 ${chunks.length} 个 RAG 分块和资料包：${brief.topic}`,
      estimatedTokens: content.length,
      createdAt
    }
  );
  const nextState = withGeneratedArtifactWorkflowRun(stateWithEvents, {
    workflow: "import_ingestion",
    entityType: "import_source",
    entityId: source.id,
    inputSummary: `${source.sourceType} 资料：${source.title}`
  });

  return {
    source,
    chunks,
    brief,
    nextState
  };
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

export function createReadingAssetsFromSearchBrief(
  state: ProductState,
  briefId: string
): { readings: ReadingAsset[]; nextState: ProductState } | null {
  const brief = state.searchBriefs.find((item) => item.id === briefId);
  if (!brief) {
    return null;
  }

  const createdAt = nowIso();
  const relatedThemeIds = resolveSearchBriefThemeIds(state, brief);
  const readings = brief.sources.map((source): ReadingAsset => ({
    id: makeId("reading"),
    title: source.title,
    url: source.url,
    publisher: source.publisher,
    summary: source.snippet,
    whyRead: `外部资料（来源：${source.publisher}）：作为“${brief.topic}”的延伸阅读，只能用于补充背景和形成追问，不能直接当作用户事实。`,
    status: "待了解",
    usage: "延伸阅读",
    relatedThemeIds,
    important: false,
    createdAt,
    updatedAt: createdAt
  }));

  const nextState = withAuditEvent(
    withExternalMaterialMemoryCandidate({
      ...cloneState(state),
      readings: [...readings, ...state.readings]
    }, brief, createdAt),
    {
      type: "search_brief_asset_created",
      label: "搜索简报已转为延伸阅读",
      detail: `从搜索简报“${brief.topic}”生成 ${readings.length} 条延伸阅读。`,
      severity: "info",
      entityType: "search_brief",
      entityId: brief.id,
      createdAt
    }
  );

  return { readings, nextState };
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

function withReferenceMaterialMemoryCandidate(
  state: ProductState,
  source: ImportSource,
  chunks: RagChunk[],
  createdAt: string
): ProductState {
  if (state.systemConfig.memory.externalMaterialMemoryPolicy !== "auto-candidate") {
    return state;
  }

  const candidate: MemoryCandidate = withMemoryCandidateReview({
    id: makeId("memory-candidate"),
    text: `用户正在把《${source.title}》作为导入资料，用来补充下一次专访的外部参照和判断线索。`,
    status: "pending",
    sourceType: "import_source",
    sourceId: source.id,
    evidenceQuote: pickSearchBriefText(chunks.map((chunk) => chunk.text), source.title),
    reason: `导入资料《${source.title}》已生成 RAG 分块和可带入专访的资料包；根据当前记忆策略，只生成待审核候选，用户确认后才进入长期记忆。`,
    sensitivity: source.sensitivity,
    createdAt
  });

  return {
    ...state,
    memoryCandidates: [candidate, ...state.memoryCandidates]
  };
}

function chunkReferenceMaterial(content: string): string[] {
  const paragraphs = content
    .split(/\n{2,}|\r?\n/)
    .map((part) => part.trim())
    .filter(Boolean);
  const chunks = paragraphs.length > 0 ? paragraphs : [content.trim()];

  return chunks.flatMap((chunk) => {
    if (chunk.length <= 360) {
      return [chunk];
    }
    const sentences = chunk.split(/(?<=[。！？.!?])\s*/).map((part) => part.trim()).filter(Boolean);
    if (sentences.length <= 1) {
      return chunk.match(/.{1,360}/g) ?? [chunk];
    }

    const grouped: string[] = [];
    let current = "";
    for (const sentence of sentences) {
      if (current && `${current}${sentence}`.length > 360) {
        grouped.push(current);
        current = sentence;
      } else {
        current = `${current}${sentence}`;
      }
    }
    if (current) {
      grouped.push(current);
    }
    return grouped;
  }).slice(0, 8);
}

function extractReferenceMaterialKeywords(text: string) {
  const tokens = text
    .split(/[、，。,.!?！？；;：:\s/]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && token.length <= 12);
  return Array.from(new Set(tokens)).slice(0, 6);
}

function getReferenceMaterialPublisher(sourceUrl: string) {
  try {
    return new URL(sourceUrl).hostname.replace(/^www\./, "") || "导入资料";
  } catch {
    return "导入资料";
  }
}

function buildReferenceMaterialSummary(title: string, chunks: RagChunk[]) {
  const firstChunk = chunks[0]?.text ?? "这份资料需要继续补充内容。";
  return `导入资料《${title}》已拆成 ${chunks.length} 个可检索片段，首要线索是：${firstChunk}`;
}

function pickSearchBriefText(values: string[], fallback: string) {
  const value = values.find((item) => item.trim());
  return sanitizeExternalMaterialText(value ?? fallback, fallback);
}

function formatSearchBriefSourceLabel(brief: SearchBrief) {
  const source = brief.sources[0];
  if (!source) {
    return brief.provider;
  }
  return `${source.publisher}｜${source.title}`;
}

function buildSearchBriefSourceEvidence(brief: SearchBrief) {
  return brief.sources.slice(0, 3).map((source) => `来源：${source.publisher}｜${source.title}｜${source.url}`);
}

function resolveSearchBriefThemeIds(state: ProductState, brief: SearchBrief) {
  const corpus = [brief.topic, brief.summary, ...brief.discussionTopics, ...brief.interviewAngles].join(" ");
  const matched = state.themes
    .filter((theme) => {
      const summarySignal = theme.summary.trim().slice(0, 8);
      return corpus.includes(theme.name) || (summarySignal.length >= 4 && corpus.includes(summarySignal));
    })
    .map((theme) => theme.id);
  return matched.length > 0 ? matched.slice(0, 2) : state.themes.slice(0, 1).map((theme) => theme.id);
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

export function receiveUserTurn(session: InterviewSession, userText: string): InterviewSession {
  const trimmed = userText.trim();
  if (!trimmed) {
    return session;
  }

  const assistant = buildAssistantTurn(session, trimmed);

  return receiveUserTurnWithAssistant(session, trimmed, {
    content: assistant.content,
    intent: assistant.intent,
    referencedMemory: assistant.referencedMemory,
    strategyDecision: assistant.strategyDecision
  });
}

export function receiveUserTurnWithAssistant(
  session: InterviewSession,
  userText: string,
  assistant: { content: string; intent: string; referencedMemory?: string; strategyDecision?: InterviewStrategyDecision }
): InterviewSession {
  const trimmed = userText.trim();
  if (!trimmed) {
    return session;
  }

  const timestamp = nowIso();
  const userTurn: InterviewTurn = {
    id: makeId("turn-user"),
    role: "user",
    content: trimmed,
    intent: "用户表达",
    timestamp
  };

  return {
    ...session,
    turns: [
      ...session.turns,
      userTurn,
      {
        id: makeId("turn-assistant"),
        role: "assistant",
        content: assistant.content,
        intent: assistant.intent,
        timestamp,
        referencedMemory: assistant.referencedMemory ?? session.card.historyReferences[0],
        strategy: assistant.strategyDecision?.strategy,
        depth: assistant.strategyDecision?.depth
      }
    ],
    strategyTrace: assistant.strategyDecision
      ? [...(session.strategyTrace ?? []), assistant.strategyDecision]
      : session.strategyTrace,
    askedAnchor: extractAnchor(trimmed)
  };
}

export function updateInterviewControl(session: InterviewSession, action: InterviewControlAction): InterviewSession {
  const timestamp = nowIso();
  const feedback = controlFeedback(session, action);
  return {
    ...session,
    strength: feedback.nextStrength,
    doNotSave: action === "do-not-save" ? true : session.doNotSave,
    turns: [
      ...session.turns,
      {
        id: makeId("turn-control"),
        role: "assistant",
        content: feedback.content,
        intent: "控制反馈",
        timestamp,
        referencedMemory: session.card.historyReferences[0]
      }
    ]
  };
}

function controlFeedback(
  session: InterviewSession,
  action: InterviewControlAction
): { nextStrength: InterviewStrength; content: string } {
  const anchor = session.askedAnchor ?? "这个问题";
  switch (action) {
    case "skip":
      return {
        nextStrength: session.strength,
        content: `可以，先跳过“${anchor}”。我会把它放进线索池，不在本轮继续追。我们换到一个更低压力的问题：这件事里你现在最确定的一点是什么？`
      };
    case "softer":
      return {
        nextStrength: "gentle",
        content: "收到，我会放慢一点，先不做尖锐挑战。我们先把事实和你的真实感受分开讲清楚。"
      };
    case "sharper":
      return {
        nextStrength: "sharp",
        content: "收到，我会更直接一点。接下来我会优先检查前提、代价和你可能回避的地方。"
      };
    case "different-angle":
      return {
        nextStrength: session.strength,
        content: `我们换个角度：如果从系统视角看，“${anchor}”不是个人问题，而是机制一直在奖励某种行为，那它奖励的是什么？`
      };
    case "summary":
      return {
        nextStrength: session.strength,
        content: "我先做阶段总结：你不是单纯在说要不要继续介入，而是在问自己能不能承受放手后的短期代价。下一步最值得问的是：这个代价能否被小范围验证？"
      };
    case "do-not-save":
      return {
        nextStrength: session.strength,
        content: "本次我会按不保存处理。你仍然可以继续说，但结束后不会沉淀到长期档案。"
      };
  }
}

function buildAssistantTurn(session: InterviewSession, userText: string): InterviewTurn & { strategyDecision: InterviewStrategyDecision } {
  const decision = decideInterviewStrategy(session, userText);
  const pairIndex = Math.floor(session.turns.length / 2);
  const anchor = extractAnchor(userText);
  const lower = userText.toLowerCase();
  const mentionsRescue = userText.includes("兜底") || userText.includes("救火");
  const mentionsLoss = userText.includes("失控") || userText.includes("延期") || userText.includes("最坏");

  let intent = decision.label;
  let content = `你刚才的锚点是“${anchor}”。如果不从谁对谁错看，而从机制看：这个系统现在到底奖励谁等你来兜底？`;

  if (decision.strategy === "concrete_example_probe") {
    content = `先别急着概括成判断。你能讲一个最近的具体时刻吗：当时谁在场，发生了什么，哪一句话让你觉得“${anchor}”？`;
  } else if (decision.strategy === "mechanism_reversal_probe") {
    content = `反过来看，这个具体时刻里可能不是某个人不主动，而是机制奖励了“等你拍板”。如果把它当成一个系统问题，谁因为等待获得了安全感，谁承担了真实代价？`;
  } else if (decision.strategy === "debt_followup") {
    const debt = session.guide.openDebts.find((item) => item.concept === session.guide.debtToAddress) ?? session.guide.openDebts[0];
    content = debt
      ? `我想回访一个知识债：上次提到的“${debt.concept}”，你现在能用自己的话解释它吗？如果还不能，卡住你的到底是概念本身，还是它和你团队现场的关系？`
      : `我想回访一个知识债：“${session.guide.debtToAddress}”。你现在能用自己的话解释它和这件事的关系吗？`;
  } else if (decision.strategy === "perspective_shift") {
    const perspective = decision.perspective ?? session.guide.recommendedPerspectives[0] ?? "系统论";
    const memory = decision.referencedMemory ?? session.card.historyReferences[0];
    content = `如果从${perspective}视角看，我先引用一条你的历史：“${memory}”。这件事里真正被系统奖励的行为是什么？谁因为等你兜底而少承担了判断？`;
  } else if (decision.strategy === "blindspot_probe") {
    const concept = decision.blindspotConcept ?? session.guide.blindspotCandidates[0]?.concept ?? "短期失控的可承受边界";
    content = `你有没有想过“${concept}”也在影响这件事？如果不是某个人不主动，而是这个默认习惯一直被保留下来，你最该验证的一个信号是什么？`;
  } else if (decision.strategy === "synthesis") {
    content = `我们先收束一下：你反复提到的不是“${anchor}”本身，而是它背后的判断机制。到现在为止，最值得验证的一个假设是什么？`;
  } else if (pairIndex === 0 && mentionsRescue) {
    intent = "追问机制";
    content = mentionsLoss
      ? "你把“兜底”和“失控”放在了一起。这里我想追具体一点：如果你不兜底，最坏的代价是什么，是延期、质量，还是你对团队判断力的信任会被击穿？"
      : "你说不想再兜底。这里先别急着找方法：你现在替他们兜住的到底是执行，还是判断的责任？";
  } else if (pairIndex === 1 && mentionsLoss) {
    intent = "挑战前提";
    content = "你已经说到了最坏情况。那我挑战一下：你是不是默认了“短期失控一定比长期依赖更糟”？这个前提还成立吗？";
  } else if (session.mode === "point" || lower.includes("我觉得")) {
    intent = "反方观点";
    content = `如果把“${anchor}”当成一个观点，它最强的反例是什么？有没有一个场景里你会承认这个判断不成立？`;
  } else if (session.mode === "learning") {
    intent = "学习复述";
    content = `先不用讲你看了多少资料。你能不能用自己的话解释“${anchor}”，再说它能解释你当前哪个真实问题？`;
  } else if (pairIndex >= 2) {
    intent = "阶段总结";
    content = "我先收一下：你不是单纯在说团队不主动，而是在问自己愿不愿意承受放手之后的短期代价。这里最值得下次继续的是：你到底能接受哪一种失控？";
  }

  if (isLongUserAnswer(userText)) {
    content = buildMirroredFollowUp(userText, content);
  }

  const pendingControl = findPendingControlAction(session);
  if (pendingControl) {
    content = applyPendingControlToFollowUp(pendingControl, userText, content);
  }

  return {
    id: makeId("turn-assistant"),
    role: "assistant",
    content,
    intent,
    timestamp: nowIso(),
    referencedMemory: decision.referencedMemory ?? session.card.historyReferences[0],
    strategy: decision.strategy,
    depth: decision.depth,
    strategyDecision: {
      ...decision,
      label: intent
    }
  };
}

function isLongUserAnswer(text: string) {
  const compactLength = text.replace(/\s/g, "").length;
  const clauseCount = text.split(/[，。；;,.!?！？]/).filter((item) => item.trim().length > 0).length;
  return compactLength >= 70 || clauseCount >= 4;
}

function buildMirroredFollowUp(userText: string, followUp: string) {
  return `我先复述一下：${summarizeUserAnswerForMirror(userText)}。接下来我想追问：${trimFollowUp(followUp)}`;
}

function summarizeUserAnswerForMirror(userText: string) {
  if (userText.includes("团队执行慢") && (userText.includes("判断") || userText.includes("边界"))) {
    return "你不是只在说团队执行慢，而是在说风险出现时，判断边界又被交回到你这里";
  }
  if ((userText.includes("救火") || userText.includes("兜底")) && userText.includes("判断")) {
    return "你不是只在说要不要继续救火，而是在说判断责任为什么总会回到你这里";
  }
  if (userText.includes("失控") && userText.includes("授权")) {
    return "你不是只在说授权会不会失控，而是在说自己能不能承受放手后的短期代价";
  }

  const anchor = extractAnchor(userText);
  return `你不是只在说“${anchor}”，而是在说它背后的责任、边界和真实代价`;
}

function trimFollowUp(followUp: string) {
  return followUp.replace(/^我先复述一下：.+?。接下来我想追问：/, "").trim();
}

function findPendingControlAction(session: InterviewSession): InterviewControlAction | undefined {
  const lastUserTurnIndex = findLastTurnIndex(session.turns, "user");
  for (let index = session.turns.length - 1; index > lastUserTurnIndex; index -= 1) {
    const turn = session.turns[index];
    if (turn.role !== "assistant" || turn.intent !== "控制反馈") {
      continue;
    }
    if (turn.content.includes("先跳过")) {
      return "skip";
    }
    if (turn.content.includes("放慢一点")) {
      return "softer";
    }
    if (turn.content.includes("更直接")) {
      return "sharper";
    }
    if (turn.content.includes("换个角度")) {
      return "different-angle";
    }
    if (turn.content.includes("阶段总结")) {
      return "summary";
    }
    if (turn.content.includes("不保存")) {
      return "do-not-save";
    }
  }
  return undefined;
}

function findLastTurnIndex(turns: InterviewTurn[], role: InterviewTurn["role"]) {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    if (turns[index].role === role) {
      return index;
    }
  }
  return -1;
}

function applyPendingControlToFollowUp(action: InterviewControlAction, userText: string, followUp: string) {
  const anchor = extractAnchor(userText);
  const mirrored = isMirroredFollowUp(followUp);
  switch (action) {
    case "softer":
      if (mirrored) {
        return `我先放慢一点，${followUp} 我们先把事实说清楚，再看它是不是机制问题。`;
      }
      return `我先放慢一点，先把事实说清楚：围绕“${anchor}”，刚才具体发生了什么？我们先不急着下判断，再看它是不是机制问题。`;
    case "sharper":
      if (mirrored) {
        return `我会更直接一点，但${followUp}`;
      }
      return `我会更直接一点，先挑战一个前提：${trimFollowUp(followUp)}`;
    case "different-angle":
      if (mirrored) {
        return `沿着刚才换的角度看，${followUp}`;
      }
      return `沿着刚才换的角度看，这更像一个机制问题：${trimFollowUp(followUp)}`;
    case "skip":
      if (mirrored) {
        return `不回到刚才跳过的问题。${followUp}`;
      }
      return `不回到刚才跳过的问题。你现在提到“${shortUserQuote(userText)}”，我们从这个新线索开始：它具体发生在哪个项目里？`;
    case "summary":
      return mirrored ? `我先接着做收束：${followUp}` : `我先接着做收束：${trimFollowUp(followUp)}`;
    case "do-not-save":
      return mirrored ? `本次仍按不保存处理。${followUp}` : `本次仍按不保存处理。${trimFollowUp(followUp)}`;
  }
}

function isMirroredFollowUp(followUp: string) {
  return followUp.startsWith("我先复述一下：");
}

function shortUserQuote(text: string) {
  const normalized = text.replace(/[，。！？、,.!?]/g, " ").replace(/\s+/g, " ").trim();
  return normalized.length > 18 ? `${normalized.slice(0, 18)}...` : normalized || "这个新线索";
}

export function decideInterviewStrategy(session: InterviewSession, userText: string): InterviewStrategyDecision {
  const previousUserTurns = session.turns.filter((turn) => turn.role === "user").length;
  const trace = session.strategyTrace ?? [];
  const perspectiveShiftCount = trace.filter((item) => item.strategy === "perspective_shift").length;
  const nextPerspective = session.guide.recommendedPerspectives[perspectiveShiftCount];
  const referencedMemory = pickReferencedMemory(session, userText);
  const maxFollowUpDepth = Math.max(1, session.enginePolicy?.maxFollowUpDepth ?? 4);
  const base = {
    turnIndex: previousUserTurns + 1,
    referencedMemory
  };

  if (
    hasConcreteMomentPlaybookRule(session) &&
    previousUserTurns === 0 &&
    isAbstractInterviewClaim(userText) &&
    !hasStrategy(trace, "concrete_example_probe")
  ) {
    return {
      ...base,
      strategy: "concrete_example_probe",
      label: "索要具体时刻",
      reason: "已应用语料学习补丁：抽象评价先落到具体时刻。",
      depth: "surface"
    };
  }

  if (
    hasMechanismReversalPlaybookRule(session) &&
    previousUserTurns >= 1 &&
    trace.at(-1)?.strategy === "concrete_example_probe" &&
    hasConcreteInterviewMoment(userText) &&
    !hasStrategy(trace, "mechanism_reversal_probe")
  ) {
    return {
      ...base,
      strategy: "mechanism_reversal_probe",
      label: "机制反转",
      reason: "已应用语料学习补丁：具体例子之后从机制、奖励和代价角度反问。",
      depth: "mechanism"
    };
  }

  if (previousUserTurns >= 1 && hasReachedStageSummaryWindow(session) && trace.at(-1)?.strategy !== "synthesis") {
    return {
      ...base,
      strategy: "synthesis",
      label: "阶段总结",
      reason: "访谈已超过 10 分钟，先阶段总结，避免继续发散。",
      depth: "synthesis"
    };
  }

  if ((previousUserTurns === 1 || previousUserTurns === 2) && session.guide.debtToAddress && !hasStrategy(trace, "debt_followup")) {
    return {
      ...base,
      strategy: "debt_followup",
      label: "知识债追问",
      reason: `第 2-3 轮回访未完成知识债：${session.guide.debtToAddress}`,
      depth: "mechanism"
    };
  }

  if (previousUserTurns >= 7 && session.guide.blindspotCandidates.length > 0 && !hasStrategy(trace, "blindspot_probe")) {
    const candidate = session.guide.blindspotCandidates[0];
    return {
      ...base,
      strategy: "blindspot_probe",
      label: "盲区探测",
      reason: `对话进入中后段，引入盲区候选：${candidate.concept}`,
      depth: "meta",
      blindspotConcept: candidate.concept
    };
  }

  if (previousUserTurns >= 3 && nextPerspective) {
    return {
      ...base,
      strategy: "perspective_shift",
      label: "视角切换",
      reason: `按引导稿补充推荐视角：${nextPerspective}`,
      depth: perspectiveShiftCount === 0 ? "mechanism" : "meta",
      perspective: nextPerspective
    };
  }

  if (previousUserTurns >= maxFollowUpDepth && trace.at(-1)?.strategy !== "synthesis") {
    return {
      ...base,
      strategy: "synthesis",
      label: "阶段总结",
      reason: `已达到本会话配置的连续追问深度上限：${maxFollowUpDepth}`,
      depth: "synthesis"
    };
  }

  if (previousUserTurns === 1 && (userText.includes("失控") || userText.includes("延期") || userText.includes("最坏"))) {
    return {
      ...base,
      strategy: "premise_challenge",
      label: "挑战前提",
      reason: "用户已经触及最坏情况，检查短期失控和长期依赖的前提。",
      depth: "mechanism"
    };
  }

  if (previousUserTurns >= Math.max(3, session.guide.recommendedPerspectives.length + 4)) {
    return {
      ...base,
      strategy: "synthesis",
      label: "阶段总结",
      reason: "已有多轮材料，先收束为可验证假设。",
      depth: "synthesis"
    };
  }

  return {
    ...base,
    strategy: "mechanism_probe",
    label: "追问机制",
    reason: "默认从用户表达中的锚点推进到机制层。",
    depth: previousUserTurns === 0 ? "surface" : "mechanism"
  };
}

function hasStrategy(trace: InterviewStrategyDecision[], strategy: InterviewStrategyId) {
  return trace.some((item) => item.strategy === strategy);
}

function hasReachedStageSummaryWindow(session: InterviewSession) {
  const startedAtMs = new Date(session.startedAt).getTime();
  if (!Number.isFinite(startedAtMs)) {
    return false;
  }
  return Date.now() - startedAtMs >= 10 * 60 * 1000;
}

function hasConcreteMomentPlaybookRule(session: InterviewSession) {
  return (session.enginePolicy?.appliedPlaybookRules ?? []).some((rule) => rule.includes("具体时刻"));
}

function hasMechanismReversalPlaybookRule(session: InterviewSession) {
  return (session.enginePolicy?.appliedPlaybookRules ?? []).some(
    (rule) => rule.includes("机制") && rule.includes("奖励") && rule.includes("代价")
  );
}

function isAbstractInterviewClaim(text: string) {
  const abstractSignals = ["整体", "总是", "一直", "就是", "都", "不主动", "很难", "不愿意", "承担", "判断", "增长", "团队"];
  const concreteSignals = ["昨天", "今天", "上周", "会议", "那次", "当时", "他说", "她说", "客户", "项目", "具体"];
  const hasAbstractSignal = abstractSignals.some((signal) => text.includes(signal));
  const hasConcreteSignal = concreteSignals.some((signal) => text.includes(signal));
  return hasAbstractSignal && !hasConcreteSignal;
}

function hasConcreteInterviewMoment(text: string) {
  const momentSignals = ["昨天", "今天", "上周", "会议", "当时", "他说", "她说", "负责人", "客户", "项目"];
  return momentSignals.some((signal) => text.includes(signal));
}

function pickReferencedMemory(session: InterviewSession, userText: string) {
  const anchor = extractAnchor(userText);
  return (
    session.guide.relevantMemories.find((memory) => memory.includes(anchor)) ??
    session.card.historyReferences.find((memory) => memory.includes(anchor)) ??
    session.guide.relevantMemories[0] ??
    session.card.historyReferences[0]
  );
}

function extractAnchor(text: string): string {
  const candidates = ["兜底", "救火", "失控", "判断", "授权", "机制", "责任", "团队", "项目"];
  const found = candidates.find((candidate) => text.includes(candidate));
  if (found) {
    return found;
  }
  const normalized = text.replace(/[，。！？、,.!?]/g, " ");
  const longest = normalized
    .split(/\s+/)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)[0];
  return longest?.slice(0, 12) || "这个问题";
}

export function buildInterviewQualityReport(session: InterviewSession): InterviewQualityReport {
  const trace = session.strategyTrace ?? [];
  const perspectivesUsed = Array.from(new Set(trace.map((item) => item.perspective).filter((item): item is string => Boolean(item))));
  const depthsReached = Array.from(new Set(trace.map((item) => item.depth)));
  const perspectiveDecisions = trace.filter((item) => item.strategy === "perspective_shift");
  const perspectiveWithHistory = perspectiveDecisions.filter((item) => Boolean(item.referencedMemory)).length;
  const historyReferenceRate = perspectiveDecisions.length === 0 ? 0 : perspectiveWithHistory / perspectiveDecisions.length;
  const transcript = session.turns.map((turn) => turn.content).join("\n");
  const forbiddenTerms = ["作为AI", "作为 AI", "我不能提供", "免责声明"].filter((term) => transcript.includes(term));
  const baseGates = [
    buildQualityGate(
      "perspective_coverage",
      "视角覆盖",
      perspectivesUsed.length >= 2,
      "至少 2 个推荐视角进入追问",
      `${perspectivesUsed.length} 个：${perspectivesUsed.join(" / ") || "无"}`,
      "避免专访只在单一解释框架里循环。"
    ),
    buildQualityGate(
      "debt_followup",
      "知识债回访",
      trace.some((item) => item.strategy === "debt_followup"),
      "至少回访 1 个未完成知识债",
      trace.some((item) => item.strategy === "debt_followup") ? "已回访" : "未回访",
      "保证会话不是孤立聊天，而是延续长期学习线索。"
    ),
    buildQualityGate(
      "blindspot_probe",
      "盲区探测",
      trace.some((item) => item.strategy === "blindspot_probe"),
      "至少引入 1 个盲区候选",
      trace.find((item) => item.strategy === "blindspot_probe")?.blindspotConcept ?? "未触达",
      "让访谈能挑战用户尚未主动提到的解释维度。"
    ),
    buildQualityGate(
      "history_reference_rate",
      "历史引用率",
      historyReferenceRate >= 1,
      "视角提问 100% 引用历史",
      `${Math.round(historyReferenceRate * 100)}%`,
      "每次视角切换都必须落回用户自己的历史材料。"
    ),
    buildQualityGate(
      "meta_depth",
      "元认知深度",
      depthsReached.includes("meta") || depthsReached.includes("synthesis"),
      "至少触达 1 次元认知或综合层",
      depthsReached.join(" / ") || "无",
      "真正的专访需要从事实推进到机制和自我观察。"
    ),
    buildQualityGate(
      "forbidden_terms",
      "禁用客服化表达",
      forbiddenTerms.length === 0,
      "禁用词 0 次",
      forbiddenTerms.length === 0 ? "0 次" : forbiddenTerms.join(" / "),
      "避免输出像客服、免责声明或模型自述。"
    )
  ] satisfies InterviewQualityReport["gates"];
  const realtimeGate = buildRealtimeTurnTakingGate(session);
  const gates = realtimeGate ? [...baseGates, realtimeGate] : baseGates;

  return {
    score: Math.round((gates.filter((gate) => gate.passed).length / gates.length) * 100),
    gates,
    perspectivesUsed,
    depthsReached,
    forbiddenTerms,
    historyReferenceRate,
    generatedAt: nowIso()
  };
}

function buildRealtimeTurnTakingGate(session: InterviewSession): InterviewQualityReport["gates"][number] | undefined {
  const signals = session.realtimeSignals ?? [];
  if (signals.length === 0) {
    return undefined;
  }

  const holdCount = signals.filter((signal) => signal.eventType === "hold").length;
  const interruptionCount = signals.filter((signal) => signal.eventType === "interruption").length;
  const responseCount = signals.filter((signal) => signal.eventType === "assistant_response").length;
  const violations = signals.filter((signal) => {
    if (signal.eventType === "hold") {
      return signal.phase !== "holding" || signal.shouldInterrupt;
    }
    if (signal.eventType === "interruption") {
      return signal.phase !== "listening" || !signal.shouldInterrupt;
    }
    if (signal.eventType === "assistant_response") {
      return !signal.assistantTurnId || signal.shouldInterrupt;
    }
    return false;
  });

  return buildQualityGate(
    "realtime_turn_taking",
    "实时轮替",
    violations.length === 0,
    "实时语音留白、打断和追问响应必须有可回溯信号，且不能在用户未说完时抢话。",
    `留白 ${holdCount} 次，打断 ${interruptionCount} 次，语音追问 ${responseCount} 次，异常 ${violations.length} 次。`,
    "用实时信号验证短暂停顿留白、用户打断交还控制权、语音追问可追溯。"
  );
}

export function buildQualityOperationsReport(state: ProductState): QualityOperationsReport {
  const completedSessions = state.sessions.filter((session) => session.status === "completed");
  const qualityScores = completedSessions.map((session) => session.qualityReport?.score ?? buildInterviewQualityReport(session).score);
  const assistantTurns = state.sessions.flatMap((session) => session.turns.filter((turn) => turn.role === "assistant"));
  const referencedAssistantTurns = assistantTurns.filter((turn) => Boolean(turn.referencedMemory));
  const strategyTraces = completedSessions.flatMap((session) => session.strategyTrace ?? []);
  const meaningfulFollowups = strategyTraces.filter((item) =>
    ["debt_followup", "perspective_shift", "blindspot_probe", "mechanism_reversal_probe", "premise_challenge", "synthesis"].includes(item.strategy)
  );
  const forbiddenTerms = completedSessions.flatMap((session) => session.qualityReport?.forbiddenTerms ?? []);
  const searchBriefsWithSources = state.searchBriefs.filter((brief) => brief.sources.length > 0);
  const contextPackEvidence = scoreContextPackRelevance(state);
  const memoryCandidatePrecision = scoreMemoryCandidatePrecision(state);
  const playbookComparisons = buildPlaybookQualityComparisons(completedSessions);
  const metrics = [
    buildQualityOperationsMetric(
      "interview_naturalness",
      "专访自然度",
      qualityScores.length > 0 ? average(qualityScores) : noQualityEvidenceScore,
      "完成会话平均质量分 >= 80",
      qualityScores.length > 0 ? `${qualityScores.length} 个完成会话，平均 ${average(qualityScores)} 分。` : "还没有完成会话质量分。"
    ),
    buildQualityOperationsMetric(
      "followup_relevance",
      "追问相关性",
      strategyTraces.length > 0
        ? Math.round((meaningfulFollowups.length / strategyTraces.length) * 100)
        : noQualityEvidenceScore,
      "至少 70% 追问进入机制、视角、盲区或总结层",
      strategyTraces.length > 0
        ? `${meaningfulFollowups.length}/${strategyTraces.length} 个策略动作进入深层追问。`
        : "还没有策略轨迹可评估。"
    ),
    buildQualityOperationsMetric(
      "memory_citation",
      "记忆引用",
      assistantTurns.length > 0
        ? Math.round((referencedAssistantTurns.length / assistantTurns.length) * 100)
        : noQualityEvidenceScore,
      "助手追问引用历史或上下文 >= 80%",
      assistantTurns.length > 0
        ? `${referencedAssistantTurns.length}/${assistantTurns.length} 个助手回合带有引用。`
        : "还没有助手回合可评估。"
    ),
    buildQualityOperationsMetric(
      "context_pack_relevance",
      "ContextPack 相关性",
      contextPackEvidence.score,
      "会话或 ContextPack workflow 必须带入主题相关记忆、来源或图谱依据",
      contextPackEvidence.detail
    ),
    buildQualityOperationsMetric(
      "memory_candidate_precision",
      "候选记忆精度",
      memoryCandidatePrecision.score,
      "已审核候选中用户确认率 >= 80%，pending 候选需要及时处理",
      memoryCandidatePrecision.detail
    ),
    buildQualityOperationsMetric(
      "sensitive_leakage",
      "敏感泄漏",
      forbiddenTerms.length > 0 ? 0 : state.memoryCorrections.length > 0 ? 80 : 100,
      "禁用客服化表达 0 次，记忆修正后需复核",
      forbiddenTerms.length > 0
        ? `发现禁用表达：${Array.from(new Set(forbiddenTerms)).join(" / ")}。`
        : state.memoryCorrections.length > 0
          ? `${state.memoryCorrections.length} 条记忆修正待后续专访验证。`
          : "未发现禁用表达或记忆污染信号。"
    ),
    buildQualityOperationsMetric(
      "source_faithfulness",
      "来源忠实度",
      state.searchBriefs.length > 0 ? Math.round((searchBriefsWithSources.length / state.searchBriefs.length) * 100) : 100,
      "进入系统的联网素材必须保留来源",
      state.searchBriefs.length > 0
        ? `${searchBriefsWithSources.length}/${state.searchBriefs.length} 份搜索简报保留来源。`
        : "还没有联网素材，暂未触发来源风险。"
    )
  ] satisfies QualityOperationsReport["metrics"];
  const risks = buildQualityRisks(state, metrics);
  const remediationActions = buildQualityRemediationActions(state, metrics, playbookComparisons);

  return {
    generatedAt: nowIso(),
    overallScore: Math.round(average(metrics.map((metric) => metric.score))),
    metrics,
    playbookComparisons,
    recentAuditEvents: (state.auditEvents ?? []).slice(0, 6),
    recentAiRunEvents: (state.aiRunEvents ?? []).slice(0, 6),
    risks,
    remediationActions
  };
}

function buildPlaybookQualityComparisons(completedSessions: InterviewSession[]): QualityOperationsReport["playbookComparisons"] {
  const groups = new Map<string, InterviewSession[]>();

  for (const session of completedSessions) {
    const version = session.enginePolicy?.playbookVersion ?? "unknown";
    groups.set(version, [...(groups.get(version) ?? []), session]);
  }

  const rows = Array.from(groups.entries()).map(([playbookVersion, sessions]) => {
    const reports = sessions.map((session) => session.qualityReport ?? buildInterviewQualityReport(session));
    return {
      playbookVersion,
      sessionCount: sessions.length,
      averageQualityScore: average(reports.map((report) => report.score)),
      averageMemoryCitationRate: average(reports.map((report) => Math.round(report.historyReferenceRate * 100))),
      deltaFromBaseline: 0,
      recommendation: "watch" as const
    };
  });

  if (rows.length === 0) {
    return [];
  }

  const baseline =
    rows.find((row) => row.playbookVersion === "base-v1") ??
    rows.find((row) => !row.playbookVersion.includes("+patch-")) ??
    [...rows].sort((a, b) => a.averageQualityScore - b.averageQualityScore)[0];

  return rows
    .map((row) => {
      const deltaFromBaseline = row.averageQualityScore - baseline.averageQualityScore;
      return {
        ...row,
        deltaFromBaseline,
        recommendation: recommendPlaybookVersion(row.averageQualityScore, deltaFromBaseline)
      };
    })
    .sort((a, b) => b.averageQualityScore - a.averageQualityScore || a.playbookVersion.localeCompare(b.playbookVersion));
}

function recommendPlaybookVersion(
  averageQualityScore: number,
  deltaFromBaseline: number
): QualityOperationsReport["playbookComparisons"][number]["recommendation"] {
  if (deltaFromBaseline >= 10 && averageQualityScore >= 80) {
    return "promote";
  }
  if (deltaFromBaseline <= -10 || averageQualityScore < 60) {
    return "rollback";
  }
  return "watch";
}

function scoreMemoryCandidatePrecision(state: ProductState) {
  const approvedCount = state.memoryCandidates.filter((candidate) => candidate.status === "approved").length;
  const rejectedCount = state.memoryCandidates.filter((candidate) => candidate.status === "rejected").length;
  const pendingCount = state.memoryCandidates.filter((candidate) => candidate.status === "pending").length;
  const reviewedCount = approvedCount + rejectedCount;

  if (reviewedCount === 0) {
    return {
      score: pendingCount > 0 ? 50 : 100,
      detail:
        pendingCount > 0
          ? `还没有已审核候选，${pendingCount} 个仍待审核。`
          : "还没有候选记忆进入审核，暂未触发精度风险。"
    };
  }

  return {
    score: Math.round((approvedCount / reviewedCount) * 100),
    detail: `${approvedCount}/${reviewedCount} 个已审核候选被确认，${pendingCount} 个仍待审核。`
  };
}

function scoreContextPackRelevance(state: ProductState) {
  const sessionsWithContext = state.sessions.filter((session) => {
    const hasTopic = Boolean(session.guide.topicHint || session.card.title);
    const hasMemory = session.card.historyReferences.length > 0 || session.guide.relevantMemories.length > 0;
    const hasExternalSource = (session.card.sourceHighlights ?? []).length > 0;
    const hasGraphReference = session.guide.graphReferences.length > 0;
    return hasTopic && (hasMemory || hasExternalSource || hasGraphReference);
  });
  const contextPackRuns = state.workflowRuns.filter((run) => run.workflow === "context_pack_build");
  const relevantContextPackRuns = contextPackRuns.filter((run) => {
    const metadata = run.metadata ?? {};
    const memoryCount = numericMetadata(metadata, "confirmedMemoryCount") + numericMetadata(metadata, "memoryRecordCount");
    const sourceCount = numericMetadata(metadata, "sourceHighlightCount") + numericMetadata(metadata, "ragChunkCount");
    const graphCount = numericMetadata(metadata, "graphReferenceCount");
    return typeof metadata.topicHint === "string" && metadata.topicHint.trim().length > 0 && memoryCount + sourceCount + graphCount > 0;
  });
  const evidenceTotal = state.sessions.length + contextPackRuns.length;
  const relevantTotal = sessionsWithContext.length + relevantContextPackRuns.length;

  if (evidenceTotal === 0) {
    return {
      score: noQualityEvidenceScore,
      detail: "还没有会话或 ContextPack workflow 可评估。"
    };
  }

  return {
    score: Math.round((relevantTotal / evidenceTotal) * 100),
    detail: `${sessionsWithContext.length}/${state.sessions.length} 个会话具备上下文依据，${relevantContextPackRuns.length}/${contextPackRuns.length} 个 ContextPack workflow 带有主题相关证据。`
  };
}

function numericMetadata(metadata: Record<string, string | number | boolean>, key: string) {
  const value = metadata[key];
  return typeof value === "number" ? value : 0;
}

export function buildInterviewTransparencyReport(state: ProductState, limit = 3): InterviewTransparencyItem[] {
  return [...state.sessions]
    .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
    .slice(0, limit)
    .map((session) => {
      const linkedSearchBrief = session.card.searchBriefId
        ? state.searchBriefs.find((brief) => brief.id === session.card.searchBriefId)
        : undefined;
      const memoryReferences = uniqueStrings([
        ...session.card.historyReferences,
        ...session.turns
          .map((turn) => turn.referencedMemory)
          .filter((reference): reference is string => Boolean(reference))
      ]).filter((reference) => !isAgendaHistoryReference(reference)).slice(0, 4);
      const playbookReferences = buildSessionPlaybookReferences(state, session);
      const degradedEvents = state.aiRunEvents
        .filter((event) => event.entityType === "interview_session" && event.entityId === session.id && event.status === "degraded")
        .map((event) => ({
          workflow: event.workflow,
          providerId: event.providerId,
          reason: event.degradedReason ?? event.outputSummary
        }));

      return {
        sessionId: session.id,
        title: session.title,
        status: session.status,
        startedAt: session.startedAt,
        searchSources: session.card.sourceHighlights ?? [],
        agendaReferences: linkedSearchBrief?.agendaTrace
          ? [
              {
                topic: linkedSearchBrief.topic,
                agendaItemId: linkedSearchBrief.agendaTrace.agendaItemId,
                source: linkedSearchBrief.agendaTrace.source,
                intent: linkedSearchBrief.agendaTrace.intent,
                reason: linkedSearchBrief.agendaTrace.reason,
                seedAssetIds: linkedSearchBrief.agendaTrace.seedAssetIds
              }
            ]
          : [],
        memoryReferences,
        playbookReferences,
        playbookVersion: session.enginePolicy?.playbookVersion ?? state.systemConfig.interview.playbookVersion,
        interviewModel: state.systemConfig.models.interviewModel,
        strategyReasons: (session.strategyTrace ?? []).map((decision) => `${decision.label}：${decision.reason}`).slice(0, 4),
        controls: session.turns
          .filter((turn) => turn.intent === "控制反馈")
          .map((turn) => summarizeControlFeedback(turn.content)),
        realtimeSignals: (session.realtimeSignals ?? []).slice(-4).map(formatRealtimeSignalTrace),
        degradedEvents
      };
    });
}

function buildSessionPlaybookReferences(state: ProductState, session: InterviewSession): InterviewTransparencyItem["playbookReferences"] {
  const appliedRules = session.enginePolicy?.appliedPlaybookRules ?? [];
  if (appliedRules.length === 0) {
    return [];
  }

  const appliedRuleSet = new Set(appliedRules);
  const playbookVersion = session.enginePolicy?.playbookVersion ?? "";
  const versionMatchedPatches = state.playbookPatches.filter((patch) =>
    playbookVersion.includes(`patch-${patch.id.slice(-4)}`)
  );
  const ruleMatchedPatches = state.playbookPatches.filter((patch) =>
    patch.rules.some((rule) => appliedRuleSet.has(rule))
  );
  const patches = versionMatchedPatches.length > 0 ? versionMatchedPatches : ruleMatchedPatches;

  return patches
    .map((patch) => {
      const insight = state.corpusInsights.find((item) => item.id === patch.sourceInsightId);
      const corpusImport = insight ? state.corpusImports.find((item) => item.id === insight.importId) : undefined;
      const rules = patch.rules.filter((rule) => appliedRuleSet.has(rule));
      const sourceImportId = insight?.importId ?? patch.sourceImportId;
      const sourceTitle = corpusImport?.title ?? patch.sourceTitle;
      const sourceUrl = corpusImport?.sourceUrl ?? patch.sourceUrl;

      return {
        patchId: patch.id,
        title: patch.title,
        status: patch.status,
        impact: patch.impact,
        sourceInsightId: patch.sourceInsightId,
        ...(sourceImportId ? { sourceImportId } : {}),
        ...(sourceTitle ? { sourceTitle } : {}),
        ...(sourceUrl ? { sourceUrl } : {}),
        rules: (rules.length > 0 ? rules : patch.rules).slice(0, 4)
      };
    })
    .filter((reference) => reference.rules.length > 0);
}

function isAgendaHistoryReference(reference: string) {
  return reference.startsWith("主动搜集依据（");
}

export function appendRealtimeSignalTrace(
  session: InterviewSession,
  signal: RealtimeSignal,
  realtimeState: RealtimeTurnState,
  options: {
    transcript?: string;
    assistantTurn?: InterviewTurn | null;
    createdAt?: string;
  } = {}
): InterviewSession {
  const transcript = options.transcript?.trim();
  const assistantTurn = options.assistantTurn ?? null;
  const trace: RealtimeSessionSignal = {
    id: makeId("realtime-signal"),
    eventType: deriveRealtimeSignalEventType(realtimeState, assistantTurn),
    phase: realtimeState.phase,
    ...(transcript ? { transcript } : {}),
    inputLevel: Math.max(0, Math.min(1, signal.inputLevel)),
    silenceMs: Math.max(0, Math.round(signal.silenceMs)),
    shouldInterrupt: realtimeState.shouldInterrupt,
    ...(realtimeState.backchannel ? { backchannel: realtimeState.backchannel } : {}),
    nextAction: realtimeState.nextAction,
    ...(assistantTurn ? { assistantTurnId: assistantTurn.id, assistantIntent: assistantTurn.intent } : {}),
    createdAt: options.createdAt ?? nowIso()
  };

  return {
    ...session,
    realtimeSignals: [...(session.realtimeSignals ?? []), trace].slice(-24)
  };
}

export interface TruncateAssistantTurnInput {
  turnId?: string;
  providerTurnId?: string;
  spokenTextSoFar: string;
  reason?: "user_interrupt" | "provider_error";
  truncatedAt?: string;
}

export interface TruncateAssistantTurnResult {
  session: InterviewSession;
  truncatedTurn: InterviewTurn | null;
  changed: boolean;
}

export function truncateAssistantTurn(
  session: InterviewSession,
  input: TruncateAssistantTurnInput
): TruncateAssistantTurnResult {
  const turns = session.turns ?? [];
  const reason = input.reason ?? "user_interrupt";
  const truncatedAt = input.truncatedAt ?? nowIso();

  const targetIndex = (() => {
    if (input.turnId) {
      const byId = turns.findIndex((turn) => turn.id === input.turnId && turn.role === "assistant");
      if (byId >= 0) return byId;
    }
    if (input.providerTurnId) {
      const byProvider = turns.findIndex(
        (turn) => turn.role === "assistant" && turn.providerTurnId === input.providerTurnId
      );
      if (byProvider >= 0) return byProvider;
    }
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      const turn = turns[index];
      if (turn.role === "assistant" && !turn.truncated) {
        return index;
      }
    }
    return -1;
  })();

  if (targetIndex < 0) {
    return { session, truncatedTurn: null, changed: false };
  }

  const target = turns[targetIndex];
  const originalChars = target.content.length;
  const spoken = input.spokenTextSoFar ?? "";
  const spokenChars = Math.min(spoken.length, originalChars);

  if (spokenChars === originalChars && !target.truncated) {
    return { session, truncatedTurn: target, changed: false };
  }

  const nextContent = spokenChars > 0 ? spoken.slice(0, spokenChars) : "";
  const nextTurn: InterviewTurn = {
    ...target,
    content: nextContent,
    truncated: {
      spokenChars,
      originalChars,
      reason,
      truncatedAt
    }
  };
  const nextTurns = [...turns];
  nextTurns[targetIndex] = nextTurn;
  return {
    session: { ...session, turns: nextTurns },
    truncatedTurn: nextTurn,
    changed: true
  };
}

function deriveRealtimeSignalEventType(
  realtimeState: RealtimeTurnState,
  assistantTurn: InterviewTurn | null
): RealtimeSessionSignal["eventType"] {
  if (assistantTurn) {
    return "assistant_response";
  }
  if (realtimeState.shouldInterrupt) {
    return "interruption";
  }
  if (realtimeState.phase === "holding") {
    return "hold";
  }
  return "listening";
}

function formatRealtimeSignalTrace(signal: RealtimeSessionSignal) {
  const labels: Record<RealtimeSessionSignal["eventType"], string> = {
    listening: "持续聆听",
    hold: "留白",
    interruption: "打断",
    assistant_response: "语音追问",
    user_started_speaking: "用户开口",
    user_stopped_speaking: "用户停顿",
    user_input_transcribed: "用户转写",
    agent_state_changed: "Agent 状态切换",
    agent_speech_committed: "语音追问完成",
    agent_speech_interrupted: "语音追问被截断",
    metrics_collected: "指标采集"
  };
  const transcript = signal.transcript ? `｜${signal.transcript}` : "";
  const assistantIntent = signal.assistantIntent ? `｜${signal.assistantIntent}` : "";
  const backchannel = signal.backchannel ? `｜${signal.backchannel}` : "";
  const spoken = signal.spokenTextSoFar ? `｜已说出 ${signal.spokenTextSoFar.length} 字` : "";
  const label = labels[signal.eventType] ?? signal.eventType;
  return `${label} · ${signal.phase} · ${signal.silenceMs}ms${backchannel}${assistantIntent}${transcript}${spoken}`;
}

function summarizeControlFeedback(content: string) {
  if (content.includes("换个角度")) {
    return "控制反馈：不同角度";
  }
  if (content.includes("放慢")) {
    return "控制反馈：放慢一点";
  }
  if (content.includes("更直接")) {
    return "控制反馈：更直接";
  }
  if (content.includes("跳过")) {
    return "控制反馈：跳过";
  }
  if (content.includes("阶段总结")) {
    return "控制反馈：阶段总结";
  }
  if (content.includes("不保存")) {
    return "控制反馈：本次不保存";
  }
  return "控制反馈：已调整";
}

function uniqueStrings(values: string[]) {
  return Array.from(new Set(values.filter((value) => value.trim().length > 0)));
}

function buildQualityOperationsMetric(
  id: QualityOperationsReport["metrics"][number]["id"],
  label: string,
  score: number,
  target: string,
  detail: string
): QualityOperationsReport["metrics"][number] {
  const boundedScore = Math.max(0, Math.min(100, Math.round(score)));
  return {
    id,
    label,
    score: boundedScore,
    target,
    status: boundedScore >= 85 ? "pass" : boundedScore >= 70 ? "watch" : "risk",
    detail
  };
}

function buildQualityRisks(state: ProductState, metrics: QualityOperationsReport["metrics"]) {
  const risks = [
    ...metrics
      .filter((metric) => metric.status === "risk")
      .map((metric) => `${metric.label}低于目标：${metric.detail}`),
    ...(state.memoryCorrections.length > 0
      ? ["最近有记忆修正，需要确认后续专访不会继续引用错误表达。"]
      : []),
    ...(state.aiRunEvents.some((event) => event.status === "failed")
      ? ["存在失败 AI 运行事件，需要检查 provider 配置和用户提示。"]
      : []),
    ...(state.aiRunEvents.some((event) => event.status === "degraded")
      ? ["存在降级 AI 运行事件，需要检查 provider 配置和用户提示。"]
      : []),
    ...(state.auditEvents.some((event) => event.severity === "critical")
      ? ["存在 critical 审计事件，需要先处理再继续自动化沉淀。"]
      : [])
  ];
  return Array.from(new Set(risks)).slice(0, 6);
}

function buildQualityGuardrails(state: ProductState) {
  return buildQualityOperationsReport(state)
    .remediationActions.map((action) => action.nextInterviewInstruction)
    .slice(0, 4);
}

function buildQualityRemediationActions(
  state: ProductState,
  metrics: QualityOperationsReport["metrics"],
  playbookComparisons: QualityOperationsReport["playbookComparisons"]
): QualityRemediationAction[] {
  const metricById = new Map(metrics.map((metric) => [metric.id, metric]));
  const completedSessionCount = state.sessions.filter((session) => session.status === "completed").length;
  const assistantTurnCount = state.sessions.flatMap((session) => session.turns.filter((turn) => turn.role === "assistant")).length;
  const strategyTraceCount = state.sessions.flatMap((session) => session.strategyTrace ?? []).length;
  const pendingCandidateCount = state.memoryCandidates.filter((candidate) => candidate.status === "pending").length;
  const reviewedCandidateCount = state.memoryCandidates.filter((candidate) => candidate.status === "approved" || candidate.status === "rejected").length;
  const contextEvidenceCount = state.sessions.length + state.workflowRuns.filter((run) => run.workflow === "context_pack_build").length;
  const actions: QualityRemediationAction[] = [];

  if (state.memoryCorrections.length > 0) {
    const metric = metricById.get("sensitive_leakage");
    actions.push({
      id: "quality-remediation-sensitive-leakage",
      sourceMetricId: "sensitive_leakage",
      priority: "high",
      owner: "memory_review",
      title: "先处理记忆修正",
      action: `复核 ${state.memoryCorrections.length} 条记忆修正，必要时废弃或改写相关长期记忆。`,
      evidence: metric?.detail ?? "存在记忆修正记录。",
      nextInterviewInstruction: "先确认上一轮记忆修正，避免把被纠正的表述当作已确认事实；必要时用一句话向用户核对。"
    });
  }

  const interviewNaturalness = metricById.get("interview_naturalness");
  const failedRealtimeTurnGate = findFailedRealtimeTurnTakingGate(state);
  if (failedRealtimeTurnGate) {
    actions.push({
      id: "quality-remediation-realtime-turn-taking",
      sourceMetricId: "interview_naturalness",
      priority: "high",
      owner: "interview_director",
      title: "修复实时轮替",
      action: "下一场实时语音必须先修复留白、打断和追问响应节奏，避免用户未说完就进入追问。",
      evidence: failedRealtimeTurnGate.actual,
      nextInterviewInstruction: "实时轮替质量门未通过：先延长留白，用户打断时立刻停止输出；只有转写完成且超过静默阈值后再生成下一句追问。"
    });
  }

  if (completedSessionCount > 0 && interviewNaturalness && interviewNaturalness.status !== "pass") {
    actions.push({
      id: "quality-remediation-interview-naturalness",
      sourceMetricId: "interview_naturalness",
      priority: interviewNaturalness.status === "risk" ? "high" : "medium",
      owner: "interview_director",
      title: "补齐专访质量门",
      action: "下一场必须主动覆盖未通过质量门，优先补视角、历史引用、知识债和元认知收束。",
      evidence: interviewNaturalness.detail,
      nextInterviewInstruction: "上一轮质量门未达标：本轮每次追问都要落到具体事实、历史引用或机制假设，并在末段做一次元认知收束。"
    });
  }

  const followupRelevance = metricById.get("followup_relevance");
  if (strategyTraceCount > 0 && followupRelevance && followupRelevance.status !== "pass") {
    actions.push({
      id: "quality-remediation-followup-relevance",
      sourceMetricId: "followup_relevance",
      priority: followupRelevance.status === "risk" ? "high" : "medium",
      owner: "interview_director",
      title: "提高追问相关性",
      action: "减少泛泛复述，优先使用机制追问、盲区探测、知识债回访和综合收束。",
      evidence: followupRelevance.detail,
      nextInterviewInstruction: "本轮不要停留在情绪复述；每个关键回答后追一个机制、代价、盲区或验证标准。"
    });
  }

  const memoryCitation = metricById.get("memory_citation");
  if (assistantTurnCount > 0 && memoryCitation && memoryCitation.status !== "pass") {
    actions.push({
      id: "quality-remediation-memory-citation",
      sourceMetricId: "memory_citation",
      priority: memoryCitation.status === "risk" ? "high" : "medium",
      owner: "interview_director",
      title: "补强历史引用",
      action: "视角切换和关键追问必须引用已确认记忆、搜索来源或明确说明没有可用依据。",
      evidence: memoryCitation.detail,
      nextInterviewInstruction: "视角切换前先引用一条已确认历史或本次 ContextPack 依据，避免凭空总结用户。"
    });
  }

  const contextPackRelevance = metricById.get("context_pack_relevance");
  if (contextEvidenceCount > 0 && contextPackRelevance && contextPackRelevance.status !== "pass") {
    actions.push({
      id: "quality-remediation-context-pack",
      sourceMetricId: "context_pack_relevance",
      priority: contextPackRelevance.status === "risk" ? "high" : "medium",
      owner: "interview_director",
      title: "重建 ContextPack",
      action: "启动下一场前检查主题、已确认记忆、联网素材和图谱依据是否进入 ContextPack。",
      evidence: contextPackRelevance.detail,
      nextInterviewInstruction: "如果本轮 ContextPack 证据不足，先围绕主题补问事实来源，不要直接推进抽象结论。"
    });
  }

  const memoryCandidatePrecision = metricById.get("memory_candidate_precision");
  if ((pendingCandidateCount > 0 || reviewedCandidateCount > 0) && memoryCandidatePrecision && memoryCandidatePrecision.status !== "pass") {
    actions.push({
      id: "quality-remediation-memory-candidate-precision",
      sourceMetricId: "memory_candidate_precision",
      priority: memoryCandidatePrecision.status === "risk" ? "high" : "medium",
      owner: "memory_review",
      title: "清理候选记忆",
      action: `先处理 ${pendingCandidateCount} 条待审核候选，降低错误候选进入长期记忆的概率。`,
      evidence: memoryCandidatePrecision.detail,
      nextInterviewInstruction: "不要把待审核候选记忆当作确定事实；引用前必须标明待确认或改成核对问题。"
    });
  }

  const sourceFaithfulness = metricById.get("source_faithfulness");
  if (state.searchBriefs.length > 0 && sourceFaithfulness && sourceFaithfulness.status !== "pass") {
    actions.push({
      id: "quality-remediation-source-faithfulness",
      sourceMetricId: "source_faithfulness",
      priority: sourceFaithfulness.status === "risk" ? "high" : "medium",
      owner: "interview_director",
      title: "修复来源忠实度",
      action: "没有来源的联网简报不能直接进入专访知识引用，先补来源或降级为假设。",
      evidence: sourceFaithfulness.detail,
      nextInterviewInstruction: "引用外部信息时必须带来源；没有来源的内容只能作为待验证假设。"
    });
  }

  const rollbackComparison = playbookComparisons.find((comparison) => comparison.recommendation === "rollback");
  if (rollbackComparison) {
    actions.push({
      id: `quality-remediation-playbook-${rollbackComparison.playbookVersion}`,
      priority: "high",
      owner: "interview_director",
      title: "回滚低质 Playbook",
      action: `暂停 ${rollbackComparison.playbookVersion}，回到表现更稳定的 playbook 版本。`,
      evidence: `平均质量 ${rollbackComparison.averageQualityScore} 分，相对基线 ${rollbackComparison.deltaFromBaseline}。`,
      nextInterviewInstruction: `不要继续沿用 ${rollbackComparison.playbookVersion} 的低质访谈技法，先回到基线追问策略。`
    });
  }

  if (state.aiRunEvents.some((event) => event.status === "failed" || event.status === "degraded")) {
    const latest =
      state.aiRunEvents.find((event) => event.status === "failed") ??
      state.aiRunEvents.find((event) => event.status === "degraded");
    actions.push({
      id: "quality-remediation-provider-degraded",
      priority: "medium",
      owner: "provider_ops",
      title: "复核 Provider 降级",
      action: "检查模型、搜索、TTS 或 workflow provider 配置，确认降级路径不会污染用户体验。",
      evidence: latest?.degradedReason ?? latest?.outputSummary ?? "存在降级 AI 运行事件。",
      nextInterviewInstruction: "如果本轮 provider 降级，明确走短句追问和本地上下文，不要伪装成完整联网或语音能力。"
    });
  }

  if (state.auditEvents.some((event) => event.severity === "critical")) {
    const latest = state.auditEvents.find((event) => event.severity === "critical");
    actions.push({
      id: "quality-remediation-critical-audit",
      priority: "high",
      owner: "provider_ops",
      title: "处理 critical 审计事件",
      action: "暂停相关自动化沉淀，先处理 critical 审计事件后再恢复写入长期记忆。",
      evidence: latest?.detail ?? "存在 critical 审计事件。",
      nextInterviewInstruction: "本轮不要自动沉淀敏感或高风险结论；需要用户明确确认后再写入记忆。"
    });
  }

  return uniqueQualityRemediationActions(actions)
    .sort((left, right) => {
      const priorityDelta = qualityActionPriorityRank(right) - qualityActionPriorityRank(left);
      if (priorityDelta !== 0) {
        return priorityDelta;
      }
      return qualityActionSourceRank(right) - qualityActionSourceRank(left);
    })
    .slice(0, 8);
}

function uniqueQualityRemediationActions(actions: QualityRemediationAction[]) {
  const seen = new Set<string>();
  return actions.filter((action) => {
    if (seen.has(action.id)) {
      return false;
    }
    seen.add(action.id);
    return true;
  });
}

function qualityActionPriorityRank(action: QualityRemediationAction) {
  return action.priority === "high" ? 3 : action.priority === "medium" ? 2 : 1;
}

function qualityActionSourceRank(action: QualityRemediationAction) {
  const rank: Partial<Record<QualityOperationsReport["metrics"][number]["id"], number>> = {
    sensitive_leakage: 70,
    interview_naturalness: 60,
    memory_citation: 50,
    followup_relevance: 40,
    context_pack_relevance: 30,
    memory_candidate_precision: 20,
    source_faithfulness: 10
  };
  return action.sourceMetricId ? rank[action.sourceMetricId] ?? 0 : 0;
}

function findFailedRealtimeTurnTakingGate(state: ProductState) {
  for (const session of state.sessions) {
    if (session.status !== "completed") {
      continue;
    }
    const report = session.qualityReport ?? buildInterviewQualityReport(session);
    const realtimeGate = report.gates.find((gate) => gate.id === "realtime_turn_taking");
    if (realtimeGate && !realtimeGate.passed) {
      return realtimeGate;
    }
  }
  return undefined;
}

function average(values: number[]) {
  if (values.length === 0) {
    return 0;
  }
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function buildQualityGate(
  id: InterviewQualityReport["gates"][number]["id"],
  label: string,
  passed: boolean,
  target: string,
  actual: string,
  detail: string
): InterviewQualityReport["gates"][number] {
  return { id, label, passed, target, actual, detail };
}

export function finalizeSession(state: ProductState, session: InterviewSession): FinalizeResult {
  const completedAt = nowIso();
  const userTurns = session.turns.filter((turn) => turn.role === "user");
  const assistantTurns = session.turns.filter((turn) => turn.role === "assistant");
  const keyQuote = pickKeyQuote(userTurns.map((turn) => turn.content));
  const anchor = extractAnchor(keyQuote);

  const note: DualTrackNote = {
    id: makeId("note"),
    sessionId: session.id,
    title: session.title,
    summary: `这次访谈把“${anchor}”从一个情绪化表达推进到了责任边界和机制代价的问题。`,
    keyQuote,
    saidTrack: [
      keyQuote,
      "用户不只是想减少介入，也在担心放手后的短期风险。",
      "用户开始把问题从个人能力转向机制和责任分配。"
    ],
    learnedTrack: [
      "真正的分歧可能不是要不要救火，而是能不能承受不救火的代价。",
      "如果机制一直奖励等待用户拍板，团队很难自然承担判断。",
      "下次需要把“最坏情况”拆成可验证的风险，而不是笼统的失控。"
    ],
    nextQuestions: [
      "如果你不亲自救火，最坏会发生什么？",
      "你愿意用哪一个小范围项目测试放手？"
    ],
    createdAt: completedAt
  };

  const completedSession: InterviewSession = {
    ...session,
    status: "completed",
    completedAt,
    qualityReport: buildInterviewQualityReport(session)
  };

  if (session.doNotSave) {
    const nextState = withInterviewFinalizedEvents(
      {
        ...cloneState(state),
        sessions: [completedSession, ...state.sessions]
      },
      completedSession,
      note,
      completedAt
    );

    return {
      note,
      nextState
    };
  }

  const nextState = cloneState(state);
  const memoryCandidate = buildMemoryCandidateFromSession(session, note, keyQuote, completedAt);
  nextState.sessions = [completedSession, ...nextState.sessions];
  nextState.searchBriefs = markSearchBriefAppliedToSession(nextState.searchBriefs, completedSession);
  nextState.notes = [note, ...nextState.notes];
  nextState.memoryCandidates = [memoryCandidate, ...(nextState.memoryCandidates ?? [])];
  nextState.points = [
    {
      id: makeId("point"),
      title: "我需要重新定义救火和授权的边界",
      content: "继续兜底能降低短期风险，但会延长团队对我拍板的依赖。",
      status: "被挑战中",
      confidence: "待验证",
      evidence: [keyQuote],
      relatedThemeIds: ["theme-control"],
      important: true,
      updatedAt: completedAt
    },
    ...nextState.points
  ];
  nextState.questions = [
    {
      id: makeId("question"),
      question: "如果我不救火，最坏会发生什么？",
      whyImportant: "这个问题决定用户能否从抽象授权推进到真实代价评估。",
      status: "正在聚焦",
      appearances: 1,
      relatedThemeIds: ["theme-control"],
      nextPrompt: "把最坏情况拆成延期、质量、客户、团队信任四类风险。",
      important: true,
      updatedAt: completedAt
    },
    ...nextState.questions
  ];
  nextState.decisions = [
    {
      id: makeId("decision"),
      title: "是否继续亲自救火",
      decisionKind: "候选决策",
      confirmationStatus: "待用户确认",
      choice: "候选低成本验证路径：先选一个低风险项目减少直接兜底。",
      tradeOff: "短期会暴露团队判断缺口，但能验证机制是否真的可承压。",
      riskHypothesis: "没有用户兜底时，项目可能延期，但团队会更快暴露真正缺口。",
      reviewAt: "2026-07-10",
      status: "待复盘",
      updatedAt: completedAt
    },
    ...nextState.decisions
  ];
  nextState.debts = [
    {
      id: makeId("debt"),
      concept: "授权机制",
      context: "本次访谈中，用户把救火和团队承担判断联系起来。",
      whyImportant: "它能帮助用户区分“给任务”和“给判断权”。",
      status: "待了解",
      nextQuestion: "你能不能用一个项目例子说明什么叫真正授权？",
      updatedAt: completedAt
    },
    ...nextState.debts
  ];
  nextState.themes = nextState.themes.map((theme) =>
    theme.name === "控制感"
      ? {
          ...theme,
          maturity: "聚焦",
          appearances: theme.appearances + 1,
          representativeQuote: keyQuote,
          nextQuestion: "如果你允许短期失控，最坏会发生什么？",
          updatedAt: completedAt
        }
      : theme
  );

  if (!nextState.themes.some((theme) => theme.name === "控制感")) {
    nextState.themes.unshift({
      id: "theme-control",
      name: "控制感",
      summary: "用户正在探索放手、授权和短期失控之间的关系。",
      maturity: "聚焦",
      representativeQuote: keyQuote,
      appearances: 1,
      nextQuestion: "如果你允许短期失控，最坏会发生什么？",
      updatedAt: completedAt
    });
  }

  if (assistantTurns.length === 0) {
    note.learnedTrack.push("本次没有形成足够的 AI 追问，应标记为轻量记录。");
  }

  return {
    note,
    nextState: withInterviewFinalizedEvents(nextState, completedSession, note, completedAt)
  };
}

function markSearchBriefAppliedToSession(searchBriefs: SearchBrief[], session: InterviewSession) {
  const searchBriefId = session.card.searchBriefId;
  if (!searchBriefId) {
    return searchBriefs;
  }

  return searchBriefs.map((brief) => {
    if (brief.id !== searchBriefId || brief.appliedToSessionIds.includes(session.id)) {
      return brief;
    }
    return {
      ...brief,
      appliedToSessionIds: [session.id, ...brief.appliedToSessionIds]
    };
  });
}

function withInterviewFinalizedEvents(
  state: ProductState,
  session: InterviewSession,
  note: DualTrackNote,
  createdAt: string
): ProductState {
  const score = session.qualityReport?.score ?? 0;
  const stateWithMemoryReferenceEvents = withMemoryReferencedAuditEvents(state, session, createdAt);
  return withAiRunEvent(
    withAuditEvent(stateWithMemoryReferenceEvents, {
      type: "interview_session_finalized",
      label: session.doNotSave ? "专访已结束但未写入长期资产" : "专访已结束并沉淀资产",
      detail: `《${session.title}》生成双轨笔记《${note.title}》，质量分 ${score}。`,
      severity: score >= 80 ? "info" : "warning",
      entityType: "interview_session",
      entityId: session.id,
      createdAt
    }),
    {
      workflow: "interview_quality_scoring",
      providerId: "deterministic-engine",
      status: "succeeded",
      entityType: "interview_session",
      entityId: session.id,
      inputSummary: `会话轮次：${session.turns.length}`,
      outputSummary: `质量分 ${score}，通过 ${session.qualityReport?.gates.filter((gate) => gate.passed).length ?? 0} 个质量门。`,
      latencyMs: 1,
      createdAt
    }
  );
}

function withMemoryReferencedAuditEvents(state: ProductState, session: InterviewSession, createdAt: string): ProductState {
  const referencedMemories = uniqueStrings(
    session.turns
      .filter((turn) => turn.role === "assistant")
      .map((turn) => turn.referencedMemory?.trim() ?? "")
  );

  return referencedMemories.reduce((nextState, memoryText) => {
    const record = findReferencedMemoryRecord(nextState, memoryText);
    return withAuditEvent(nextState, {
      type: "memory_referenced",
      label: "专访引用长期记忆",
      detail: `《${session.title}》引用：${memoryText}`,
      severity: "info",
      entityType: record ? "memory_record" : "memory",
      entityId: record?.id ?? makeStableMemoryReferenceId(memoryText),
      createdAt
    });
  }, state);
}

function findReferencedMemoryRecord(state: ProductState, memoryText: string) {
  const exactMatch = state.memoryRecords.find(
    (record) =>
      record.status === "confirmed" &&
      (record.text === memoryText ||
        memoryText.includes(record.text) ||
        record.text.includes(memoryText) ||
        record.evidenceQuote === memoryText)
  );
  if (exactMatch) {
    return exactMatch;
  }

  const referenceTokens = tokenizeMemoryGraphText(memoryText);
  return state.memoryRecords
    .filter((record) => record.status === "confirmed")
    .map((record) => {
      const recordTokens = tokenizeMemoryGraphText(`${record.text} ${record.evidenceQuote}`);
      const overlap = Array.from(referenceTokens).filter((token) => recordTokens.has(token));
      const score = overlap.reduce((total, token) => total + (token.length >= 3 ? 1.5 : 1), 0);
      return { record, score };
    })
    .filter((item) => item.score >= 2)
    .sort((a, b) => b.score - a.score)[0]?.record;
}

function makeStableMemoryReferenceId(memoryText: string) {
  const normalized = memoryText.replace(/\s+/g, "").slice(0, 24);
  return normalized ? `memory-reference-${normalized}` : "memory-reference-unknown";
}

function buildMemoryCandidateFromSession(
  session: InterviewSession,
  note: DualTrackNote,
  keyQuote: string,
  createdAt: string
): MemoryCandidate {
  const anchor = extractAnchor(keyQuote);
  const text = `用户反复关注“${anchor}”背后的判断责任和机制代价。`;
  return withMemoryCandidateReview({
    id: makeId("memory-candidate"),
    text,
    status: "pending",
    sourceType: "interview_session",
    sourceId: session.id,
    evidenceQuote: keyQuote,
    reason: `来自会后双轨笔记《${note.title}》，需要用户确认后才进入长期记忆。`,
    sensitivity: keyQuote.includes("不满") || keyQuote.includes("否定") ? "sensitive" : "normal",
    createdAt
  });
}

function pickKeyQuote(quotes: string[]): string {
  return (
    quotes
      .filter(Boolean)
      .sort((a, b) => scoreQuote(b) - scoreQuote(a))[0] ?? "这次我还没有说清楚真正的问题。"
  );
}

function scoreQuote(quote: string): number {
  const signalWords = ["不是", "兜底", "救火", "最坏", "失控", "判断", "机制", "责任"];
  return quote.length + signalWords.filter((word) => quote.includes(word)).length * 20;
}

export function buildMonthlyReview(state: ProductState): MonthlyReview {
  const topTheme = [...state.themes].sort((a, b) => b.appearances - a.appearances)[0];
  const openQuestion = state.questions.find((question) => question.status !== "阶段性回答");

  return {
    topTheme: topTheme?.name ?? "暂无长期主题",
    changedView: "你正在从“团队不主动”转向“机制是否让团队承担判断”。",
    avoidedQuestion: openQuestion?.question ?? "还没有形成明确的回避问题。",
    recommendedNextInterview: topTheme?.nextQuestion ?? "从最近一条关键原话继续。",
    metrics: {
      notes: state.notes.length,
      points: state.points.length,
      questions: state.questions.length,
      knowledgeDebts: state.debts.length,
      themes: state.themes.length
    }
  };
}

export function markMemoryCorrection(state: ProductState, text: string): ProductState {
  const createdAt = nowIso();
  const correction = {
    id: makeId("correction"),
    text,
    createdAt
  };
  return withAuditEvent(
    {
      ...state,
      memoryCorrections: [correction, ...state.memoryCorrections]
    },
    {
      type: "memory_correction_created",
      label: "记忆修正已创建",
      detail: text,
      severity: "warning",
      entityType: "memory",
      entityId: correction.id,
      createdAt
    }
  );
}

export function approveMemoryCandidate(state: ProductState, candidateId: string): ProductState {
  const candidate = state.memoryCandidates.find((item) => item.id === candidateId);
  if (!candidate || candidate.status !== "pending") {
    return state;
  }

  const reviewedAt = nowIso();
  const record: MemoryRecord = {
    id: makeId("memory-record"),
    text: candidate.text,
    status: "confirmed",
    sourceType: candidate.sourceType,
    sourceId: candidate.sourceId,
    evidenceQuote: candidate.evidenceQuote,
    sourceCandidateId: candidate.id,
    sensitivity: candidate.sensitivity,
    createdAt: reviewedAt,
    updatedAt: reviewedAt
  };
  const clonedState = cloneState(state);
  const projectedState: ProductState = {
    ...clonedState,
    memoryRecords: [record, ...(clonedState.memoryRecords ?? [])]
  };
  const memoryEdges = buildMemoryEdgesForRecord(projectedState, record, reviewedAt);
  const nextState: ProductState = {
    ...projectedState,
    memoryCandidates: state.memoryCandidates.map((item) =>
      item.id === candidate.id
        ? {
            ...item,
            status: "approved",
            reviewedAt
          }
        : item
    ),
    memoryEdges: [...memoryEdges, ...(state.memoryEdges ?? [])]
  };

  return withAuditEvent(nextState, {
    type: "memory_candidate_approved",
    label: "候选记忆已确认",
    detail: candidate.text,
    severity: "info",
    entityType: "memory_record",
    entityId: record.id,
    createdAt: reviewedAt
  });
}

export function updateMemoryCandidateText(state: ProductState, candidateId: string, text: string): ProductState {
  const candidate = state.memoryCandidates.find((item) => item.id === candidateId);
  const revisedText = text.trim();
  if (!candidate || candidate.status !== "pending" || !revisedText || revisedText === candidate.text) {
    return state;
  }

  const updatedAt = nowIso();
  const nextState: ProductState = {
    ...cloneState(state),
    memoryCandidates: state.memoryCandidates.map((item) =>
      item.id === candidate.id
        ? withMemoryCandidateReview({
            ...item,
            text: revisedText
          }, { preserveExisting: false })
        : item
    )
  };

  return withAuditEvent(nextState, {
    type: "memory_candidate_updated",
    label: "候选记忆已修改",
    detail: `从“${candidate.text}”修改为“${revisedText}”。`,
    severity: "warning",
    entityType: "memory_candidate",
    entityId: candidate.id,
    createdAt: updatedAt
  });
}

export function updateMemoryRecordText(state: ProductState, recordId: string, text: string): ProductState {
  const record = state.memoryRecords.find((item) => item.id === recordId);
  const revisedText = text.trim();
  if (!record || record.status !== "confirmed" || !revisedText || revisedText === record.text) {
    return state;
  }

  const updatedAt = nowIso();
  const updatedRecord: MemoryRecord = {
    ...record,
    text: revisedText,
    updatedAt
  };
  const baseState: ProductState = {
    ...cloneState(state),
    memoryRecords: state.memoryRecords.map((item) => (item.id === record.id ? updatedRecord : item)),
    memoryEdges: (state.memoryEdges ?? []).filter((edge) => edge.fromMemoryRecordId !== record.id && edge.targetId !== record.id)
  };
  const nextState: ProductState = {
    ...baseState,
    memoryEdges: [...buildMemoryEdgesForRecord(baseState, updatedRecord, updatedAt), ...baseState.memoryEdges]
  };

  return withAuditEvent(nextState, {
    type: "memory_record_updated",
    label: "确认记忆已修正",
    detail: `从“${record.text}”修正为“${revisedText}”。`,
    severity: "warning",
    entityType: "memory_record",
    entityId: record.id,
    createdAt: updatedAt
  });
}

export function rejectMemoryCandidate(state: ProductState, candidateId: string, reviewNote = "用户拒绝写入长期记忆。"): ProductState {
  const candidate = state.memoryCandidates.find((item) => item.id === candidateId);
  if (!candidate || candidate.status !== "pending") {
    return state;
  }

  const reviewedAt = nowIso();
  const nextState: ProductState = {
    ...cloneState(state),
    memoryCandidates: state.memoryCandidates.map((item) =>
      item.id === candidate.id
        ? {
            ...item,
            status: "rejected",
            reviewedAt,
            reviewNote
          }
        : item
    )
  };

  return withAuditEvent(nextState, {
    type: "memory_candidate_rejected",
    label: "候选记忆已拒绝",
    detail: `${candidate.text}｜${reviewNote}`,
    severity: "warning",
    entityType: "memory_candidate",
    entityId: candidate.id,
    createdAt: reviewedAt
  });
}

export function deprecateMemoryRecord(
  state: ProductState,
  recordId: string,
  deprecatedReason = "用户撤销这条长期记忆。"
): ProductState {
  const record = state.memoryRecords.find((item) => item.id === recordId);
  if (!record || record.status !== "confirmed") {
    return state;
  }

  const updatedAt = nowIso();
  const nextState: ProductState = {
    ...cloneState(state),
    memoryRecords: state.memoryRecords.map((item) =>
      item.id === record.id
        ? {
            ...item,
            status: "deprecated",
            updatedAt,
            deprecatedReason
          }
        : item
    )
  };

  return withAuditEvent(nextState, {
    type: "memory_record_deprecated",
    label: "确认记忆已废弃",
    detail: `${record.text}｜${deprecatedReason}`,
    severity: "warning",
    entityType: "memory_record",
    entityId: record.id,
    createdAt: updatedAt
  });
}

export function deleteMemoryRecord(state: ProductState, recordId: string): ProductState {
  const record = state.memoryRecords.find((item) => item.id === recordId);
  if (!record) {
    return state;
  }

  const deletedAt = nowIso();
  const nextState: ProductState = {
    ...cloneState(state),
    memoryRecords: state.memoryRecords.filter((item) => item.id !== record.id),
    memoryEdges: (state.memoryEdges ?? []).filter((edge) => edge.fromMemoryRecordId !== record.id && edge.targetId !== record.id)
  };

  return withAuditEvent(nextState, {
    type: "memory_record_deleted",
    label: "确认记忆已删除",
    detail: record.text,
    severity: "warning",
    entityType: "memory_record",
    entityId: record.id,
    createdAt: deletedAt
  });
}

export function toggleAssetImportance(state: ProductState, assetId: string): ProductState {
  return {
    ...state,
    points: state.points.map((point) =>
      point.id === assetId ? { ...point, important: !point.important, updatedAt: nowIso() } : point
    ),
    questions: state.questions.map((question) =>
      question.id === assetId ? { ...question, important: !question.important, updatedAt: nowIso() } : question
    ),
    readings: state.readings.map((reading) =>
      reading.id === assetId ? { ...reading, important: !reading.important, updatedAt: nowIso() } : reading
    )
  };
}

export function searchProductAssets(state: ProductState, query: string): SearchResult {
  const normalized = query.trim().toLowerCase();
  const match = (values: string[]) =>
    !normalized || values.some((value) => value.toLowerCase().includes(normalized));

  const notes = state.notes.filter((note) =>
    match([note.title, note.summary, note.keyQuote, ...note.saidTrack, ...note.learnedTrack, ...note.nextQuestions])
  );
  const points = state.points.filter((point) =>
    match([point.title, point.content, point.status, point.confidence, ...point.evidence])
  );
  const questions = state.questions.filter((question) =>
    match([question.question, question.whyImportant, question.status, question.nextPrompt])
  );
  const decisions = state.decisions.filter((decision) =>
    match([
      decision.title,
      decision.decisionKind,
      decision.confirmationStatus,
      decision.choice,
      decision.tradeOff,
      decision.riskHypothesis,
      decision.status
    ])
  );
  const debts = state.debts.filter((debt) =>
    match([debt.concept, debt.context, debt.whyImportant, debt.status, debt.nextQuestion])
  );
  const readings = state.readings.filter((reading) =>
    match([
      reading.title,
      reading.url,
      reading.publisher,
      reading.summary,
      reading.whyRead,
      reading.status,
      reading.usage
    ])
  );
  const themes = state.themes.filter((theme) =>
    match([theme.name, theme.summary, theme.maturity, theme.representativeQuote, theme.nextQuestion])
  );

  return {
    query,
    total: notes.length + points.length + questions.length + decisions.length + debts.length + readings.length + themes.length,
    notes,
    points,
    questions,
    decisions,
    debts,
    readings,
    themes
  };
}

export function updateKnowledgeDebtStatus(
  state: ProductState,
  debtId: string,
  status: Extract<AssetStatus, "待了解" | "能复述" | "已应用" | "不相关">
): ProductState {
  return {
    ...state,
    debts: state.debts.map((debt) =>
      debt.id === debtId
        ? {
            ...debt,
            status,
            updatedAt: nowIso()
          }
        : debt
    )
  };
}

export function updateReadingAssetStatus(
  state: ProductState,
  readingId: string,
  status: Extract<AssetStatus, "待了解" | "已应用" | "不相关">
): ProductState {
  return {
    ...state,
    readings: state.readings.map((reading) =>
      reading.id === readingId
        ? {
            ...reading,
            status,
            updatedAt: nowIso()
          }
        : reading
    )
  };
}

export function updatePointStatus(
  state: ProductState,
  pointId: string,
  status: Extract<AssetStatus, "临时想法" | "稳定观点" | "被挑战中" | "已修正" | "已放弃">
): ProductState {
  return {
    ...state,
    points: state.points.map((point) =>
      point.id === pointId ? { ...point, status, confidence: "用户确认", updatedAt: nowIso() } : point
    )
  };
}

export function updateQuestionStatus(
  state: ProductState,
  questionId: string,
  status: Extract<AssetStatus, "开放" | "反复出现" | "正在聚焦" | "阶段性回答">
): ProductState {
  return {
    ...state,
    questions: state.questions.map((question) =>
      question.id === questionId ? { ...question, status, updatedAt: nowIso() } : question
    )
  };
}

export function updateDecisionStatus(
  state: ProductState,
  decisionId: string,
  status: "待复盘" | "已复盘"
): ProductState {
  return {
    ...state,
    decisions: state.decisions.map((decision) =>
      decision.id === decisionId
        ? {
            ...decision,
            status,
            updatedAt: nowIso()
          }
        : decision
    )
  };
}

export function confirmDecisionCandidate(state: ProductState, decisionId: string): ProductState {
  const decision = state.decisions.find((item) => item.id === decisionId);
  if (!decision || decision.confirmationStatus === "用户确认") {
    return state;
  }

  const confirmedAt = nowIso();
  const nextState: ProductState = {
    ...state,
    decisions: state.decisions.map((item) =>
      item.id === decisionId
        ? {
            ...item,
            decisionKind: "用户决策",
            confirmationStatus: "用户确认",
            updatedAt: confirmedAt
          }
        : item
    )
  };

  return withAuditEvent(nextState, {
    type: "decision_candidate_confirmed",
    label: "决策候选已确认",
    detail: decision.title,
    severity: "info",
    entityType: "decision",
    entityId: decision.id,
    createdAt: confirmedAt
  });
}

export function createQuestionFromNote(state: ProductState, noteId: string, nextQuestionIndex: number): ProductState {
  const note = state.notes.find((item) => item.id === noteId);
  const question = note?.nextQuestions[nextQuestionIndex];
  if (!note || !question) {
    return state;
  }

  return {
    ...state,
    questions: [
      {
        id: makeId("question-from-note"),
        question,
        whyImportant: `来自访谈《${note.title}》的下次回访问题。`,
        status: "开放",
        appearances: 1,
        relatedThemeIds: ["theme-control"],
        nextPrompt: question,
        important: true,
        updatedAt: nowIso()
      },
      ...state.questions
    ]
  };
}

export function submitInterviewFeedback(
  state: ProductState,
  noteId: string,
  input: InterviewFeedbackInput
): ProductState {
  const note = state.notes.find((item) => item.id === noteId);
  if (!note) {
    return state;
  }

  const createdAt = nowIso();
  const tags = normalizeFeedbackTags(input.tags);
  const feedback = {
    id: makeId("interview-feedback"),
    noteId: note.id,
    sessionId: note.sessionId,
    tags,
    mostValuableQuestion: normalizeOptionalFeedbackText(input.mostValuableQuestion),
    inaccurateSummary: normalizeOptionalFeedbackText(input.inaccurateSummary),
    uncomfortableButImportant: normalizeOptionalFeedbackText(input.uncomfortableButImportant),
    newUnderstanding: normalizeOptionalFeedbackText(input.newUnderstanding),
    continuePrompt: normalizeOptionalFeedbackText(input.continuePrompt),
    createdAt
  };

  let nextState: ProductState = {
    ...cloneState(state),
    profile: {
      ...state.profile,
      preferredStrength: deriveFeedbackStrength(state.profile.preferredStrength, tags)
    },
    notes: state.notes.map((item) => (item.id === note.id ? { ...item, feedback } : item))
  };

  const correction = buildFeedbackCorrectionText(note.title, feedback.inaccurateSummary, tags);
  if (correction) {
    nextState = markMemoryCorrection(nextState, correction);
  }

  if (tags.includes("continue-next") && feedback.continuePrompt) {
    nextState = {
      ...nextState,
      questions: [
        {
          id: makeId("question-feedback"),
          question: feedback.continuePrompt,
          whyImportant: `来自会后反馈《${note.title}》，用户明确要求下次继续追问。`,
          status: "正在聚焦",
          appearances: 1,
          relatedThemeIds: ["theme-control"],
          nextPrompt: feedback.mostValuableQuestion ?? feedback.continuePrompt,
          important: true,
          updatedAt: createdAt
        },
        ...nextState.questions
      ]
    };
  }

  return withAuditEvent(nextState, {
    type: "interview_feedback_submitted",
    label: "会后反馈已记录",
    detail: `《${note.title}》收到 ${tags.length} 个反馈标签，后续专访将参考这些偏好。`,
    severity: tags.includes("memory-wrong") || tags.includes("off-track") ? "warning" : "info",
    entityType: "dual_track_note",
    entityId: note.id,
    createdAt
  });
}

function normalizeFeedbackTags(tags: InterviewFeedbackTag[]) {
  return Array.from(new Set(tags)).filter((tag): tag is InterviewFeedbackTag =>
    ["went-deep", "off-track", "too-gentle", "too-strong", "memory-wrong", "summary-accurate", "continue-next"].includes(tag)
  );
}

function normalizeOptionalFeedbackText(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function deriveFeedbackStrength(current: InterviewStrength, tags: InterviewFeedbackTag[]): InterviewStrength {
  if (tags.includes("too-strong")) {
    return "gentle";
  }
  if (tags.includes("too-gentle") || tags.includes("went-deep")) {
    return "sharp";
  }
  if (tags.includes("off-track")) {
    return "standard";
  }
  return current;
}

function buildFeedbackCorrectionText(noteTitle: string, inaccurateSummary: string | undefined, tags: InterviewFeedbackTag[]) {
  if (!inaccurateSummary && !tags.includes("memory-wrong")) {
    return undefined;
  }
  return `会后反馈《${noteTitle}》：${inaccurateSummary ?? "用户标记 AI 记错了，需要下次避免重复这个理解。"}`;
}

export function buildCognitiveRadar(state: ProductState): CognitiveRadar {
  const noteText = state.notes.flatMap((note) => [note.summary, ...note.saidTrack, ...note.learnedTrack]).join(" ");
  const countSignal = (signals: string[]) => signals.reduce((count, signal) => count + (noteText.includes(signal) ? 1 : 0), 0);
  const max = Math.max(6, state.notes.length + state.points.length + state.questions.length);

  return {
    depth: [
      { label: "事实", value: Math.max(1, countSignal(["发生", "事件", "项目"])), max },
      { label: "机制", value: Math.max(1, countSignal(["机制", "系统", "奖励"])), max },
      { label: "感受", value: Math.max(1, countSignal(["担心", "不想", "怕"])), max },
      { label: "意义", value: Math.max(1, countSignal(["意味着", "边界", "长期"])), max },
      { label: "验证", value: Math.max(1, countSignal(["验证", "复盘", "测试"])), max }
    ],
    perspectives: [
      { label: "系统论", value: state.themes.filter((theme) => theme.summary.includes("机制") || theme.summary.includes("系统")).length + 1, max },
      { label: "心理学", value: countSignal(["担心", "信任", "控制感"]), max },
      { label: "形式科学", value: state.questions.length, max },
      { label: "叙事", value: state.notes.length, max }
    ],
    assets: [
      { label: "观点", value: state.points.length, max },
      { label: "问题", value: state.questions.length, max },
      { label: "决策", value: state.decisions.length, max },
      { label: "知识债", value: state.debts.length, max }
    ],
    statuses: [
      { label: "用户确认", value: state.points.filter((point) => point.confidence === "用户确认").length, max },
      { label: "待验证", value: state.points.filter((point) => point.confidence === "待验证").length, max },
      { label: "被挑战", value: state.points.filter((point) => point.status === "被挑战中").length, max },
      { label: "已应用", value: state.debts.filter((debt) => debt.status === "已应用").length, max }
    ]
  };
}

export function generatePodcastEpisode(
  state: ProductState,
  noteId: string,
  options: { format: PodcastEpisode["format"]; voice: string }
): { episode: PodcastEpisode; nextState: ProductState } {
  const note = state.notes.find((item) => item.id === noteId) ?? state.notes[0];
  const createdAt = nowIso();
  const title = `播客：${note.title}`;
  const script = buildPodcastScript(options.format, [
    `开场：今天我们回到《${note.title}》。`,
    `关键原话：“${note.keyQuote}”`,
    `第一部分，我说了什么：${note.saidTrack.slice(0, 2).join("；")}`,
    `第二部分，我学到了什么：${note.learnedTrack.slice(0, 2).join("；")}`,
    `收束问题：${note.nextQuestions[0] ?? "下一次从这个问题继续。"}`
  ], [
    `主持人：欢迎回来，今天我们用《${note.title}》做一段复盘对谈。`,
    `来宾：这期最值得停下来的原话是：“${note.keyQuote}”`,
    "主持人：先还原一下，当时真正说出口的是什么？",
    `来宾：${note.saidTrack.slice(0, 2).join("；")}`,
    "主持人：如果把它往下挖一层，这段经历让你学到了什么？",
    `来宾：${note.learnedTrack.slice(0, 2).join("；")}`,
    "主持人：那下一次专访最该继续追问哪一个问题？",
    `来宾：${note.nextQuestions[0] ?? "下一次从这个问题继续。"}`
  ]);
  const episode: PodcastEpisode = {
    id: makeId("podcast"),
    noteId: note.id,
    sourceType: "note",
    sourceId: note.id,
    sourceLabel: note.title,
    title,
    format: options.format,
    voice: options.voice,
    status: "draft",
    scriptReviewStatus: "待确认",
    durationSec: Math.max(180, Math.round(script.length * 0.8)),
    script,
    aiDisclosure: podcastAiDisclosure,
    chapters: [
      {
        title: "开场与背景",
        startsAtSec: 0,
        summary: note.summary
      },
      {
        title: "关键原话",
        startsAtSec: 45,
        summary: note.keyQuote
      },
      {
        title: "复盘与下一问",
        startsAtSec: 120,
        summary: note.nextQuestions[0] ?? "保留一个下次追问。"
      }
    ],
    audioUrl: `local-audio://${title.replace(/\s+/g, "-")}.mp3`,
    audioRenderStatus: "pending",
    audioRenderMessage: "脚本待确认，确认后才会渲染音频。",
    shownotes: buildPodcastShownotes(options.format, [
      `来源笔记：${note.title}`,
      `关键原话：${note.keyQuote}`,
      ...note.nextQuestions.slice(0, 2).map((question) => `下次追问：${question}`)
    ]),
    createdAt
  };
  const generatedState = {
    ...cloneState(state),
    podcastEpisodes: [episode, ...state.podcastEpisodes]
  };
  const stateWithCreationEvents = withAiRunEvent(
    withAuditEvent(generatedState, {
      type: "podcast_episode_created",
      label: "播客脚本已生成",
      detail: `从笔记《${note.title}》生成待确认脚本《${episode.title}》。`,
      severity: "info",
      entityType: "podcast_episode",
      entityId: episode.id,
      createdAt
    }),
    {
      workflow: "podcast_generation",
      providerId: state.systemConfig.models.synthesisModel,
      status: "succeeded",
      entityType: "podcast_episode",
      entityId: episode.id,
      inputSummary: `来源笔记：${note.title}`,
      outputSummary: `生成待确认播客脚本，预计 ${episode.durationSec} 秒。`,
      estimatedTokens: script.length,
      createdAt
    }
  );
  const nextState = withGeneratedArtifactWorkflowRun(stateWithCreationEvents, {
    workflow: "podcast_generation",
    entityType: "podcast_episode",
    entityId: episode.id,
    inputSummary: `来源笔记：${note.title}`
  });

  return {
    episode,
    nextState
  };
}

export function generatePodcastEpisodeFromSearchBrief(
  state: ProductState,
  briefId: string,
  options: { format: PodcastEpisode["format"]; voice: string }
): { episode: PodcastEpisode; nextState: ProductState } {
  const brief = state.searchBriefs.find((item) => item.id === briefId) ?? state.searchBriefs[0];
  if (!brief) {
    return generatePodcastEpisode(state, state.notes[0]?.id ?? "", options);
  }

  const createdAt = nowIso();
  const title = `热点播客：${brief.topic}`;
  const sourceNotes = brief.sources
    .slice(0, 3)
    .map((source) => `来源链接：${source.publisher}｜${source.title}｜${source.url}`);
  const relatedAssets = buildPodcastRelatedAssets(state);
  const script = buildPodcastScript(options.format, [
    `开场：今天我们用一份联网素材聊《${brief.topic}》。`,
    `素材摘要：${brief.summary}`,
    `关键事实：${brief.facts.slice(0, 3).join("；")}`,
    `争议：${brief.controversies.slice(0, 2).join("；")}`,
    `反方观点：${brief.opposingViews.slice(0, 2).join("；")}`,
    `可追问角度：${brief.interviewAngles.slice(0, 2).join("；")}`,
    relatedAssets.length > 0 ? `相关资产：${relatedAssets.join("；")}` : "",
    `收束问题：${brief.discussionTopics[0] ?? "这份素材和你当前最真实的判断有什么关系？"}`
  ], [
    `主持人：今天我们把联网素材《${brief.topic}》转成一段可讨论的对谈。`,
    `来宾：先给出素材摘要：${brief.summary}`,
    "主持人：这份材料里最硬的事实是什么？",
    `来宾：${brief.facts.slice(0, 3).join("；")}`,
    "主持人：如果从反方和争议看，它提醒我们不要忽略什么？",
    `来宾：争议包括：${brief.controversies.slice(0, 2).join("；")}。反方观点包括：${brief.opposingViews.slice(0, 2).join("；")}`,
    `主持人：它能怎样转成下一次专访的真实问题？`,
    `来宾：${brief.interviewAngles.slice(0, 2).join("；")}。${relatedAssets.length > 0 ? `也要关联已有资产：${relatedAssets.join("；")}` : "先把热点转回自己的判断。"}`,
    `主持人：最后留一个收束问题。`,
    `来宾：${brief.discussionTopics[0] ?? "这份素材和你当前最真实的判断有什么关系？"}`
  ]);
  const episode: PodcastEpisode = {
    id: makeId("podcast"),
    noteId: brief.id,
    sourceType: "search-brief",
    sourceId: brief.id,
    sourceLabel: brief.topic,
    title,
    format: options.format,
    voice: options.voice,
    status: "draft",
    scriptReviewStatus: "待确认",
    durationSec: Math.max(180, Math.round(script.length * 0.8)),
    script,
    aiDisclosure: podcastAiDisclosure,
    chapters: [
      {
        title: "热点背景",
        startsAtSec: 0,
        summary: brief.summary
      },
      {
        title: "争议与反方",
        startsAtSec: 60,
        summary: brief.controversies[0] ?? brief.opposingViews[0] ?? "保留反方观点。"
      },
      {
        title: "回到个人判断",
        startsAtSec: 140,
        summary: brief.discussionTopics[0] ?? "把热点转回用户自己的下一步判断。"
      }
    ],
    audioUrl: `local-audio://${title.replace(/\s+/g, "-")}.mp3`,
    audioRenderStatus: "pending",
    audioRenderMessage: "脚本待确认，确认后才会渲染音频。",
    shownotes: buildPodcastShownotes(options.format, [
      `来源素材：${brief.topic}`,
      `素材摘要：${brief.summary}`,
      ...sourceNotes,
      ...relatedAssets.map((asset) => `相关资产：${asset}`),
      ...brief.discussionTopics.slice(0, 2).map((topic) => `可讨论主题：${topic}`)
    ]),
    createdAt
  };
  const generatedState = {
    ...cloneState(state),
    podcastEpisodes: [episode, ...state.podcastEpisodes]
  };
  const stateWithCreationEvents = withAiRunEvent(
    withAuditEvent(generatedState, {
      type: "podcast_episode_created",
      label: "热点播客脚本已生成",
      detail: `从联网素材《${brief.topic}》生成待确认脚本《${episode.title}》。`,
      severity: "info",
      entityType: "podcast_episode",
      entityId: episode.id,
      createdAt
    }),
    {
      workflow: "podcast_generation",
      providerId: state.systemConfig.models.synthesisModel,
      status: "succeeded",
      entityType: "podcast_episode",
      entityId: episode.id,
      inputSummary: `来源素材：${brief.topic}`,
      outputSummary: `生成待确认热点专题播客脚本，预计 ${episode.durationSec} 秒。`,
      estimatedTokens: script.length,
      createdAt
    }
  );
  const nextState = withGeneratedArtifactWorkflowRun(stateWithCreationEvents, {
    workflow: "podcast_generation",
    entityType: "podcast_episode",
    entityId: episode.id,
    inputSummary: `来源素材：${brief.topic}`
  });

  return {
    episode,
    nextState
  };
}

export function generatePodcastEpisodeFromTheme(
  state: ProductState,
  themeId: string,
  options: { format: PodcastEpisode["format"]; voice: string }
): { episode: PodcastEpisode; nextState: ProductState } {
  const theme = state.themes.find((item) => item.id === themeId) ?? state.themes[0];
  if (!theme) {
    return generatePodcastEpisode(state, state.notes[0]?.id ?? "", options);
  }

  const createdAt = nowIso();
  const title = `主题播客：${theme.name}`;
  const relatedAssets = buildPodcastRelatedAssets(state);
  const script = buildPodcastScript(options.format, [
    `开场：今天我们围绕长期主题《${theme.name}》做一次专题回放。`,
    `主题摘要：${theme.summary}`,
    `代表原话：“${theme.representativeQuote}”`,
    `成熟度：${theme.maturity}，历史出现 ${theme.appearances} 次。`,
    relatedAssets.length > 0 ? `相关资产：${relatedAssets.join("；")}` : "",
    `收束问题：${theme.nextQuestion}`
  ], [
    `主持人：今天我们围绕长期主题《${theme.name}》做一段专题对谈。`,
    `来宾：这个主题的核心摘要是：${theme.summary}`,
    "主持人：有没有一句话最能代表它？",
    `来宾：“${theme.representativeQuote}”`,
    "主持人：从长期轨迹看，它现在成熟到什么程度？",
    `来宾：成熟度是 ${theme.maturity}，历史出现 ${theme.appearances} 次。${relatedAssets.length > 0 ? `相关资产包括：${relatedAssets.join("；")}` : ""}`,
    "主持人：下一次继续追问什么？",
    `来宾：${theme.nextQuestion}`
  ]);
  const episode: PodcastEpisode = {
    id: makeId("podcast"),
    noteId: theme.id,
    sourceType: "theme",
    sourceId: theme.id,
    sourceLabel: theme.name,
    title,
    format: options.format,
    voice: options.voice,
    status: "draft",
    scriptReviewStatus: "待确认",
    durationSec: Math.max(180, Math.round(script.length * 0.8)),
    script,
    aiDisclosure: podcastAiDisclosure,
    chapters: [
      {
        title: "主题背景",
        startsAtSec: 0,
        summary: theme.summary
      },
      {
        title: "代表原话",
        startsAtSec: 55,
        summary: theme.representativeQuote
      },
      {
        title: "下一次追问",
        startsAtSec: 130,
        summary: theme.nextQuestion
      }
    ],
    audioUrl: `local-audio://${title.replace(/\s+/g, "-")}.mp3`,
    audioRenderStatus: "pending",
    audioRenderMessage: "脚本待确认，确认后才会渲染音频。",
    shownotes: buildPodcastShownotes(options.format, [
      `长期主题：${theme.name}`,
      `主题摘要：${theme.summary}`,
      `代表原话：${theme.representativeQuote}`,
      `下一问：${theme.nextQuestion}`,
      ...relatedAssets.map((asset) => `相关资产：${asset}`)
    ]),
    createdAt
  };
  const generatedState = {
    ...cloneState(state),
    podcastEpisodes: [episode, ...state.podcastEpisodes]
  };
  const stateWithCreationEvents = withAiRunEvent(
    withAuditEvent(generatedState, {
      type: "podcast_episode_created",
      label: "主题播客脚本已生成",
      detail: `从长期主题《${theme.name}》生成待确认脚本《${episode.title}》。`,
      severity: "info",
      entityType: "podcast_episode",
      entityId: episode.id,
      createdAt
    }),
    {
      workflow: "podcast_generation",
      providerId: state.systemConfig.models.synthesisModel,
      status: "succeeded",
      entityType: "podcast_episode",
      entityId: episode.id,
      inputSummary: `长期主题：${theme.name}`,
      outputSummary: `生成待确认主题专题播客脚本，预计 ${episode.durationSec} 秒。`,
      estimatedTokens: script.length,
      createdAt
    }
  );
  const nextState = withGeneratedArtifactWorkflowRun(stateWithCreationEvents, {
    workflow: "podcast_generation",
    entityType: "podcast_episode",
    entityId: episode.id,
    inputSummary: `长期主题：${theme.name}`
  });

  return {
    episode,
    nextState
  };
}

export function generatePodcastEpisodeFromKnowledgeDebt(
  state: ProductState,
  debtId: string,
  options: { format: PodcastEpisode["format"]; voice: string }
): { episode: PodcastEpisode; nextState: ProductState } {
  const debt = state.debts.find((item) => item.id === debtId) ?? state.debts[0];
  if (!debt) {
    return generatePodcastEpisode(state, state.notes[0]?.id ?? "", options);
  }

  const createdAt = nowIso();
  const title = `学习播客：${debt.concept}`;
  const relatedAssets = buildPodcastRelatedAssets(state);
  const script = buildPodcastScript(options.format, [
    `开场：今天把知识债《${debt.concept}》做成一段学习播客。`,
    `背景：${debt.context}`,
    `为什么重要：${debt.whyImportant}`,
    `当前状态：${debt.status}`,
    relatedAssets.length > 0 ? `相关资产：${relatedAssets.join("；")}` : "",
    `收束问题：${debt.nextQuestion}`
  ], [
    `主持人：今天我们把知识债《${debt.concept}》拆成一段学习对谈。`,
    `来宾：背景是：${debt.context}`,
    "主持人：它为什么值得现在学习，而不是以后再说？",
    `来宾：${debt.whyImportant}`,
    "主持人：当前推进状态和可用线索是什么？",
    `来宾：状态是 ${debt.status}。${relatedAssets.length > 0 ? `相关资产包括：${relatedAssets.join("；")}` : "还需要继续积累证据。"}`,
    "主持人：最后留给下一次验证的问题是什么？",
    `来宾：${debt.nextQuestion}`
  ]);
  const episode: PodcastEpisode = {
    id: makeId("podcast"),
    noteId: debt.id,
    sourceType: "knowledge-debt",
    sourceId: debt.id,
    sourceLabel: debt.concept,
    title,
    format: options.format,
    voice: options.voice,
    status: "draft",
    scriptReviewStatus: "待确认",
    durationSec: Math.max(180, Math.round(script.length * 0.8)),
    script,
    aiDisclosure: podcastAiDisclosure,
    chapters: [
      {
        title: "知识债背景",
        startsAtSec: 0,
        summary: debt.context
      },
      {
        title: "为什么重要",
        startsAtSec: 55,
        summary: debt.whyImportant
      },
      {
        title: "下一次验证",
        startsAtSec: 130,
        summary: debt.nextQuestion
      }
    ],
    audioUrl: `local-audio://${title.replace(/\s+/g, "-")}.mp3`,
    audioRenderStatus: "pending",
    audioRenderMessage: "脚本待确认，确认后才会渲染音频。",
    shownotes: buildPodcastShownotes(options.format, [
      `知识债：${debt.concept}`,
      `背景：${debt.context}`,
      `为什么重要：${debt.whyImportant}`,
      `下一问：${debt.nextQuestion}`,
      ...relatedAssets.map((asset) => `相关资产：${asset}`)
    ]),
    createdAt
  };
  const generatedState = {
    ...cloneState(state),
    podcastEpisodes: [episode, ...state.podcastEpisodes]
  };
  const stateWithCreationEvents = withAiRunEvent(
    withAuditEvent(generatedState, {
      type: "podcast_episode_created",
      label: "知识债播客脚本已生成",
      detail: `从知识债《${debt.concept}》生成待确认脚本《${episode.title}》。`,
      severity: "info",
      entityType: "podcast_episode",
      entityId: episode.id,
      createdAt
    }),
    {
      workflow: "podcast_generation",
      providerId: state.systemConfig.models.synthesisModel,
      status: "succeeded",
      entityType: "podcast_episode",
      entityId: episode.id,
      inputSummary: `知识债：${debt.concept}`,
      outputSummary: `生成待确认学习播客脚本，预计 ${episode.durationSec} 秒。`,
      estimatedTokens: script.length,
      createdAt
    }
  );
  const nextState = withGeneratedArtifactWorkflowRun(stateWithCreationEvents, {
    workflow: "podcast_generation",
    entityType: "podcast_episode",
    entityId: episode.id,
    inputSummary: `知识债：${debt.concept}`
  });

  return {
    episode,
    nextState
  };
}

export function generatePodcastEpisodeFromCorpusInsight(
  state: ProductState,
  insightId: string,
  options: { format: PodcastEpisode["format"]; voice: string }
): { episode: PodcastEpisode; nextState: ProductState } {
  const insight = state.corpusInsights.find((item) => item.id === insightId) ?? state.corpusInsights[0];
  if (!insight) {
    return generatePodcastEpisode(state, state.notes[0]?.id ?? "", options);
  }

  const corpusImport = state.corpusImports.find((item) => item.id === insight.importId);
  const createdAt = nowIso();
  const sourceTitle = insight.title.replace(/：访谈逻辑分析$/, "");
  const topDimensions = insight.dimensions.slice(0, 3);
  const topImprovements = insight.improvementPlan.slice(0, 3);
  const topPatch = insight.recommendedPatches[0];
  const turnExamples = corpusImport?.turns.slice(0, 3).map((turn) => `${formatCorpusMoveLabel(turn.move)} · ${turn.speaker}：${turn.content}`) ?? [];
  const title = `语料播客：${sourceTitle}`;
  const sourceLine = corpusImport?.sourceUrl ? `样本来源：${corpusImport.sourceUrl}` : `样本来源：${corpusImport?.mediaType ?? "text"} 导入样本`;
  const script = buildPodcastScript(options.format, [
    `开场：今天把语料学习结果《${sourceTitle}》转成一段可复盘的学习播客。`,
    sourceLine,
    `核心发现：${topDimensions.map((dimension) => `${dimension.name}：${dimension.finding}`).join("；")}`,
    `样本片段：${turnExamples.join("；")}`,
    `改进方案：${topImprovements.map((item) => `${item.title}：${item.action}`).join("；")}`,
    topPatch ? `PlaybookPatch：${topPatch.title}，规则包括：${topPatch.rules.slice(0, 2).join("；")}` : "",
    `收束问题：下一次专访如何验证“${topImprovements[0]?.title ?? "样本技法"}”是否真的改善追问质量？`
  ], [
    `主持人：今天我们把语料学习结果《${sourceTitle}》做成一段复盘对谈。`,
    `来宾：先交代来源，${sourceLine}。`,
    "主持人：这份样本最值得学习的追问动作是什么？",
    `来宾：${topDimensions.map((dimension) => `${dimension.name}：${dimension.finding}`).join("；")}`,
    "主持人：有没有一段原始片段能说明它不是空泛建议？",
    `来宾：${turnExamples.join("；") || insight.dimensions[0]?.example || "样本片段需要回到原始语料核验。"}`,
    "主持人：如果把它转成当前引擎改进，应该怎么做？",
    `来宾：${topImprovements.map((item) => `${item.title}：${item.expectedEngineChange}`).join("；")}`,
    topPatch ? `主持人：可确认的 PlaybookPatch 是什么？\n来宾：${topPatch.title}，规则包括：${topPatch.rules.slice(0, 3).join("；")}` : "",
    `主持人：最后留一个验证问题。\n来宾：下一次专访如何验证“${topImprovements[0]?.title ?? "样本技法"}”是否真的改善追问质量？`
  ]);
  const episode: PodcastEpisode = {
    id: makeId("podcast"),
    noteId: insight.id,
    sourceType: "corpus-insight",
    sourceId: insight.id,
    sourceLabel: insight.title,
    title,
    format: options.format,
    voice: options.voice,
    status: "draft",
    scriptReviewStatus: "待确认",
    durationSec: Math.max(180, Math.round(script.length * 0.8)),
    script,
    aiDisclosure: podcastAiDisclosure,
    chapters: [
      {
        title: "样本来源",
        startsAtSec: 0,
        summary: sourceLine
      },
      {
        title: "关键技法",
        startsAtSec: 60,
        summary: topDimensions[0]?.finding ?? "需要回到样本追问动作。"
      },
      {
        title: "引擎改进",
        startsAtSec: 140,
        summary: topImprovements[0]?.expectedEngineChange ?? topPatch?.description ?? "等待用户确认 PlaybookPatch。"
      }
    ],
    audioUrl: `local-audio://${title.replace(/\s+/g, "-")}.mp3`,
    audioRenderStatus: "pending",
    audioRenderMessage: "脚本待确认，确认后才会渲染音频。",
    shownotes: buildPodcastShownotes(options.format, [
      `语料分析：${insight.title}`,
      sourceLine,
      ...topDimensions.map((dimension) => `分析维度：${dimension.name}｜${dimension.finding}`),
      ...topImprovements.map((item) => `改进方案：${item.title}｜${item.expectedEngineChange}`),
      ...(topPatch ? [`PlaybookPatch：${topPatch.title}`, ...topPatch.rules.slice(0, 2).map((rule) => `规则：${rule}`)] : [])
    ]),
    createdAt
  };
  const generatedState = {
    ...cloneState(state),
    podcastEpisodes: [episode, ...state.podcastEpisodes]
  };
  const stateWithCreationEvents = withAiRunEvent(
    withAuditEvent(generatedState, {
      type: "podcast_episode_created",
      label: "语料学习播客脚本已生成",
      detail: `从语料分析《${insight.title}》生成待确认脚本《${episode.title}》。`,
      severity: "info",
      entityType: "podcast_episode",
      entityId: episode.id,
      createdAt
    }),
    {
      workflow: "podcast_generation",
      providerId: state.systemConfig.models.synthesisModel,
      status: "succeeded",
      entityType: "podcast_episode",
      entityId: episode.id,
      inputSummary: `语料分析：${insight.title}`,
      outputSummary: `生成待确认语料学习播客脚本，预计 ${episode.durationSec} 秒。`,
      estimatedTokens: script.length,
      createdAt
    }
  );
  const nextState = withGeneratedArtifactWorkflowRun(stateWithCreationEvents, {
    workflow: "podcast_generation",
    entityType: "podcast_episode",
    entityId: episode.id,
    inputSummary: `语料分析：${insight.title}`
  });

  return {
    episode,
    nextState
  };
}

function buildPodcastRelatedAssets(state: ProductState) {
  return [
    state.points[0]?.title,
    state.questions[0]?.question,
    state.debts[0]?.concept,
    state.decisions[0]?.title
  ].filter((item): item is string => Boolean(item));
}

function formatCorpusMoveLabel(move: CorpusTurn["move"]) {
  const labels: Record<CorpusTurn["move"], string> = {
    opening: "开场",
    "follow-up": "追问",
    challenge: "反方挑战",
    reflection: "复述",
    answer: "回答"
  };
  return labels[move];
}

export function analyzeImportedInterview(
  state: ProductState,
  input: CorpusImportInput
): { insight: CorpusInsight; nextState: ProductState } {
  const createdAt = nowIso();
  const importId = makeId("corpus");
  const insightId = makeId("insight");
  const sanitizedInput: CorpusImportInput = {
    ...input,
    title: sanitizeExternalMaterialText(input.title, "导入专访样本"),
    content: sanitizeExternalMaterialBlock(input.content, "导入样本片段已清洗，需回到原始材料核验。")
  };
  const turns = parseCorpusTurns(sanitizedInput.content);
  const hostTurns = turns.filter((turn) => turn.speaker.includes("主持") || turn.speaker.includes("访谈"));
  const challengeCount = turns.filter((turn) => turn.move === "challenge").length;
  const followUpCount = turns.filter((turn) => turn.move === "follow-up").length;
  const concreteExample =
    turns.find((turn) => turn.content.includes("具体") || turn.content.includes("时刻"))?.content ??
    turns[0]?.content ??
    sanitizedInput.content.slice(0, 60);
  const patch: PlaybookPatch = {
    id: makeId("patch"),
    title: "先索要具体时刻，再做机制反转",
    description: "优秀样本不是直接给结论，而是先让被访者落到具体事件，再把事件翻译为机制问题。",
    sourceInsightId: insightId,
    sourceImportId: importId,
    sourceTitle: sanitizedInput.title,
    ...(sanitizedInput.sourceUrl ? { sourceUrl: sanitizedInput.sourceUrl } : {}),
    status: "proposed",
    rules: [
      "当用户使用抽象评价时，先追问一个具体时刻。",
      "当用户已经给出具体例子后，再从机制、奖励和代价角度反问。",
      "每轮只改变一个追问动作，避免把访谈变成建议清单。"
    ],
    impact: "medium",
    createdAt
  };
  const insight: CorpusInsight = {
    id: insightId,
    importId,
    title: `${sanitizedInput.title}：访谈逻辑分析`,
    dimensions: [
      {
        name: "追问动作",
        score: Math.min(5, 2 + followUpCount + challengeCount),
        finding: "样本先要求具体化，再把回答推进到机制层。",
        example: concreteExample,
        recommendedAction: "在当前引擎中增加“具体时刻 -> 机制反转”的追问序列。"
      },
      {
        name: "节奏控制",
        score: Math.min(5, 3 + Math.floor(hostTurns.length / 2)),
        finding: "主持人没有急着总结，而是在回答后保留一个二次追问空间。",
        example: hostTurns[0]?.content ?? "样本中主持人先接住回答，再推进问题。",
        recommendedAction: "用户停顿时保留短留白，不立即补问题。"
      },
      {
        name: "反方推动",
        score: Math.min(5, 2 + challengeCount),
        finding: "样本会把用户叙述翻转成机制假设，帮助形成可挑战观点。",
        example: turns.find((turn) => turn.move === "challenge")?.content ?? "如果反过来看，是不是机制奖励了报喜不报忧？",
        recommendedAction: "在观点专访中增加反例和反方假设。"
      }
    ],
    improvementPlan: [
      {
        title: "具体时刻优先",
        rationale: "样本面对抽象评价时没有立刻解释或建议，而是先把被访者带回一个可复盘的具体场景。",
        action: "用户使用“很难、很乱、不主动”等抽象评价时，先追问最近一次具体时刻。",
        expectedEngineChange: "确认后，引擎会在抽象评价后优先触发“索要具体时刻”的追问动作。",
        evidence: concreteExample
      },
      {
        title: "机制反转追问",
        rationale: "样本在拿到具体例子后，会把个体表现翻转成机制、奖励和代价问题。",
        action: "用户给出具体事件后，从机制奖励、隐性代价或反方假设继续追问。",
        expectedEngineChange: "确认后，引擎会在具体例子之后更稳定地触发“机制反转”策略。",
        evidence: turns.find((turn) => turn.move === "challenge")?.content ?? "如果反过来看，是不是机制奖励了报喜不报忧？"
      },
      {
        title: "单步节奏控制",
        rationale: "样本每轮只推进一个动作，避免把自然专访变成建议清单。",
        action: "一次只问一个问题；用户停顿时先留白，再补短反馈。",
        expectedEngineChange: "确认后，引擎会更偏向短反馈、留白和单步追问，而不是连续输出多个建议。",
        evidence: hostTurns[0]?.content ?? "样本中主持人先接住回答，再推进问题。"
      }
    ],
    recommendedPatches: [patch],
    createdAt
  };

  const stateWithCreationEvents = withAiRunEvent(
    withAuditEvent(
      withExternalCorpusMemoryCandidate({
        ...cloneState(state),
        corpusImports: [
          {
            id: importId,
            title: sanitizedInput.title,
            mediaType: sanitizedInput.mediaType,
            content: sanitizedInput.content,
            sourceUrl: sanitizedInput.sourceUrl,
            status: "analyzed",
            turns,
            createdAt
          },
          ...state.corpusImports
        ],
        corpusInsights: [insight, ...state.corpusInsights],
        playbookPatches: [patch, ...state.playbookPatches]
      }, sanitizedInput, importId, insight, createdAt),
      {
        type: "corpus_import_analyzed",
        label: "语料样本已分析",
        detail: `《${sanitizedInput.title}》生成 ${insight.dimensions.length} 个分析维度和 ${insight.recommendedPatches.length} 个 PlaybookPatch。`,
        severity: "info",
        entityType: "corpus_import",
        entityId: importId,
        createdAt
      }
    ),
    {
      workflow: "reference_interview_learning",
      providerId: "deterministic-engine",
      status: "succeeded",
      entityType: "corpus_import",
      entityId: importId,
      inputSummary: `${sanitizedInput.mediaType} 样本：${sanitizedInput.title}`,
      outputSummary: `生成补丁：${patch.title}`,
      estimatedTokens: sanitizedInput.content.length,
      createdAt
    }
  );
  const nextState = withGeneratedArtifactWorkflowRun(stateWithCreationEvents, {
    workflow: "import_ingestion",
    entityType: "corpus_import",
    entityId: importId,
    inputSummary: `${sanitizedInput.mediaType} 样本：${sanitizedInput.title}`
  });

  return {
    insight,
    nextState
  };
}

function withExternalCorpusMemoryCandidate(
  state: ProductState,
  input: CorpusImportInput,
  importId: string,
  insight: CorpusInsight,
  createdAt: string
): ProductState {
  if (state.systemConfig.memory.externalMaterialMemoryPolicy !== "auto-candidate") {
    return state;
  }

  const candidate: MemoryCandidate = withMemoryCandidateReview({
    id: makeId("memory-candidate"),
    text: `用户正在把《${input.title}》作为外部专访样本，用来改进自己的专访追问逻辑和节奏判断。`,
    status: "pending",
    sourceType: "corpus_import",
    sourceId: importId,
    evidenceQuote: pickSearchBriefText(
      insight.dimensions.map((dimension) => dimension.example),
      input.content.slice(0, 80) || input.title
    ),
    reason: `外部语料样本《${input.title}》已生成 PlaybookPatch；根据当前记忆策略，只生成待审核候选，用户确认后才进入长期记忆。`,
    sensitivity: "normal",
    createdAt
  });

  return {
    ...state,
    memoryCandidates: [candidate, ...state.memoryCandidates]
  };
}

function parseCorpusTurns(content: string): CorpusTurn[] {
  return content
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      const [rawSpeaker, ...rest] = line.split(/[:：]/);
      const speaker = rest.length > 0 ? rawSpeaker.trim() : index % 2 === 0 ? "主持人" : "被访者";
      const text = (rest.length > 0 ? rest.join("：") : line).trim();
      const isHost = speaker.includes("主持") || speaker.includes("访谈");
      const move: CorpusTurn["move"] = !isHost
        ? "answer"
        : index === 0
          ? "opening"
          : text.includes("反过来") || text.includes("是不是") || text.includes("代价")
            ? "challenge"
            : text.includes("具体") || text.includes("能不能") || text.includes("为什么")
              ? "follow-up"
              : "reflection";

      return {
        speaker,
        content: text,
        move
      };
    });
}

export function approvePlaybookPatch(state: ProductState, patchId: string): ProductState {
  const patch = state.playbookPatches.find((item) => item.id === patchId);
  if (!patch || patch.status !== "proposed") {
    return state;
  }

  const appliedAt = nowIso();
  const applyPatchStatus = (item: PlaybookPatch): PlaybookPatch =>
    item.id === patchId
      ? {
          ...item,
          status: "applied",
          appliedAt
        }
      : item;

  const stateWithPatch = {
    ...cloneState(state),
    playbookPatches: state.playbookPatches.map(applyPatchStatus),
    corpusInsights: state.corpusInsights.map((insight) => ({
      ...insight,
      recommendedPatches: insight.recommendedPatches.map(applyPatchStatus)
    }))
  };
  const nextConfig: SystemConfig = {
    ...state.systemConfig,
    version: `${state.systemConfig.version}+${patch.id.slice(-4)}`,
    interview: {
      ...state.systemConfig.interview,
      playbookVersion: `${state.systemConfig.interview.playbookVersion}+patch-${patch.id.slice(-4)}`
    }
  };
  const nextState = withSystemConfigVersion(stateWithPatch, nextConfig, {
    changedBy: "user",
    reason: `应用 PlaybookPatch：${patch.title}`,
    createdAt: appliedAt
  });

  return withAuditEvent(nextState, {
    type: "playbook_patch_applied",
    label: "PlaybookPatch 已应用",
    detail: `《${patch.title}》已进入访谈引擎，配置版本更新为 ${nextState.systemConfig.version}。`,
    severity: "warning",
    entityType: "playbook_patch",
    entityId: patch.id,
    createdAt: appliedAt
  });
}

export function revertPlaybookPatch(state: ProductState, patchId: string): ProductState {
  const revertedAt = nowIso();
  const patch = state.playbookPatches.find((item) => item.id === patchId);
  if (!patch || patch.status !== "applied") {
    return state;
  }

  const suffix = patch.id.slice(-4);
  const applyPatchStatus = (item: PlaybookPatch): PlaybookPatch =>
    item.id === patchId
      ? {
          ...item,
          status: "reverted",
          revertedAt
        }
      : item;

  const stateWithPatch = {
    ...cloneState(state),
    playbookPatches: state.playbookPatches.map(applyPatchStatus),
    corpusInsights: state.corpusInsights.map((insight) => ({
      ...insight,
      recommendedPatches: insight.recommendedPatches.map(applyPatchStatus)
    }))
  };
  const nextConfig: SystemConfig = {
    ...state.systemConfig,
    version: removeVersionSuffix(state.systemConfig.version, `+${suffix}`),
    interview: {
      ...state.systemConfig.interview,
      playbookVersion: removeVersionSuffix(state.systemConfig.interview.playbookVersion, `+patch-${suffix}`)
    }
  };
  const nextState = withSystemConfigVersion(stateWithPatch, nextConfig, {
    changedBy: "user",
    reason: `回滚 PlaybookPatch：${patch.title}`,
    createdAt: revertedAt,
    rollbackTarget: nextConfig.version
  });

  return withAuditEvent(nextState, {
    type: "playbook_patch_reverted",
    label: "PlaybookPatch 已回滚",
    detail: `《${patch.title}》已从访谈引擎移除，配置版本恢复为 ${nextState.systemConfig.version}。`,
    severity: "warning",
    entityType: "playbook_patch",
    entityId: patch.id,
    createdAt: revertedAt
  });
}

export function buildSystemStatus(state: ProductState): SystemStatus {
  const activeSearch = state.systemConfig.search.activeProvider;
  const voiceProvider = state.systemConfig.voice.ttsProvider;
  const observations = [
    state.systemConfig.search.allowWebInInterview
      ? "联网素材允许进入专访上下文，但必须显示来源。"
      : "联网素材只用于会前准备，不进入会中追问。",
    state.systemConfig.voice.realtimeEnabled
      ? "实时语音已启用，需要检查打断、留白和转写稳定性。"
      : "实时语音当前为预留配置，原型使用文本模拟。",
    state.systemConfig.memory.includeSensitiveMemoriesInContext
      ? "敏感长期记忆允许进入模型上下文，需要严格查看引用透明度。"
      : "敏感长期记忆默认不进入模型上下文。",
    state.playbookPatches.some((patch) => patch.status === "applied")
      ? "已有用户确认的访谈策略补丁影响当前引擎。"
      : "当前引擎使用 base-v1 访谈策略。"
  ];

  return {
    configVersion: state.systemConfig.version,
    activeProviders: {
      search: activeSearch,
      voice: voiceProvider,
      interviewModel: state.systemConfig.models.interviewModel
    },
    providers: state.systemConfig.providers,
    observations
  };
}

function removeVersionSuffix(version: string, suffix: string) {
  return version.split(suffix).join("");
}

export function applySystemConfigChange(
  state: ProductState,
  nextConfig: SystemConfig,
  options: { changedBy: ConfigVersion["changedBy"]; reason: string }
): ProductState {
  const createdAt = nowIso();
  const nextState = withSystemConfigVersion(state, nextConfig, {
    ...options,
    createdAt
  });
  if (nextState === state) {
    return state;
  }

  return withAuditEvent(nextState, {
    type: "system_config_changed",
    label: "配置版本已更新",
    detail: `${options.reason}，配置版本更新为 ${nextState.systemConfig.version}。`,
    severity: "info",
    entityType: "system_config_version",
    entityId: nextState.configVersions[0].id,
    createdAt
  });
}

export function rollbackSystemConfigVersion(state: ProductState, versionId: string): ProductState {
  const history = ensureConfigVersionHistory(state);
  const targetVersion = history.find((version) => version.id === versionId);
  if (!targetVersion) {
    return state;
  }

  const createdAt = nowIso();
  const nextState = withSystemConfigVersion(state, targetVersion.snapshot, {
    changedBy: "user",
    reason: `回滚到配置版本 ${targetVersion.version}`,
    createdAt,
    rollbackTarget: targetVersion.version
  });
  if (nextState === state) {
    return state;
  }

  return withAuditEvent(nextState, {
    type: "system_config_reverted",
    label: "配置版本已回滚",
    detail: `已回滚到 ${targetVersion.version}，后续流程将使用该配置快照。`,
    severity: "warning",
    entityType: "system_config_version",
    entityId: nextState.configVersions[0].id,
    createdAt
  });
}

function withSystemConfigVersion(
  state: ProductState,
  nextConfig: SystemConfig,
  options: {
    changedBy: ConfigVersion["changedBy"];
    reason: string;
    createdAt: string;
    rollbackTarget?: string;
  }
): ProductState {
  const nextConfigWithVersion = ensureNextConfigVersion(state.systemConfig, nextConfig, options.createdAt);
  const diff = describeSystemConfigDiff(state.systemConfig, nextConfigWithVersion);
  if (diff.length === 0 && state.systemConfig.version === nextConfigWithVersion.version) {
    return state;
  }

  const history = ensureConfigVersionHistory(state).map((version) => ({
    ...version,
    active: false
  }));
  const versionRecord: ConfigVersion = {
    id: makeId("cfgv"),
    version: nextConfigWithVersion.version,
    createdAt: options.createdAt,
    changedBy: options.changedBy,
    reason: options.reason,
    diff,
    active: true,
    rollbackTarget: options.rollbackTarget ?? state.systemConfig.version,
    affectedSessions: state.sessions.map((session) => session.id),
    snapshot: cloneConfig(nextConfigWithVersion)
  };

  return {
    ...cloneState(state),
    systemConfig: nextConfigWithVersion,
    configVersions: [versionRecord, ...history]
  };
}

function ensureNextConfigVersion(previousConfig: SystemConfig, nextConfig: SystemConfig, createdAt: string): SystemConfig {
  if (nextConfig.version !== previousConfig.version) {
    return cloneConfig(nextConfig);
  }

  return {
    ...cloneConfig(nextConfig),
    version: `${previousConfig.version}+cfg-${new Date(createdAt).getTime().toString(36)}`
  };
}

function ensureConfigVersionHistory(state: ProductState): ConfigVersion[] {
  if (state.configVersions.length > 0) {
    return state.configVersions;
  }

  return [
    {
      id: makeId("cfgv"),
      version: state.systemConfig.version,
      createdAt: nowIso(),
      changedBy: "system",
      reason: "初始配置基线",
      diff: [],
      active: true,
      affectedSessions: state.sessions.map((session) => session.id),
      snapshot: cloneConfig(state.systemConfig)
    }
  ];
}

function describeSystemConfigDiff(previousConfig: SystemConfig, nextConfig: SystemConfig) {
  const previous = flattenConfig(previousConfig);
  const next = flattenConfig(nextConfig);
  const keys = Array.from(new Set([...Object.keys(previous), ...Object.keys(next)])).sort();
  return keys
    .filter((key) => previous[key] !== next[key])
    .map((key) => `${key}: ${previous[key] ?? "未设置"} -> ${next[key] ?? "未设置"}`);
}

function flattenConfig(value: unknown, prefix = ""): Record<string, string> {
  if (!value || typeof value !== "object") {
    return prefix ? { [prefix]: String(value ?? "") } : {};
  }

  return Object.entries(value as Record<string, unknown>).reduce<Record<string, string>>((flattened, [key, nestedValue]) => {
    if (key === "version") {
      return flattened;
    }
    const path = prefix ? `${prefix}.${key}` : key;
    if (Array.isArray(nestedValue)) {
      flattened[path] = JSON.stringify(nestedValue);
      return flattened;
    }
    if (nestedValue && typeof nestedValue === "object") {
      return {
        ...flattened,
        ...flattenConfig(nestedValue, path)
      };
    }
    flattened[path] = String(nestedValue ?? "");
    return flattened;
  }, {});
}

function cloneConfig(config: SystemConfig): SystemConfig {
  return JSON.parse(JSON.stringify(config)) as SystemConfig;
}

export function buildRealtimeTurnState(session: InterviewSession, signal: RealtimeSignal): RealtimeTurnState {
  const silenceHoldMs = Math.max(300, session.enginePolicy?.silenceHoldMs ?? 1200);
  if (signal.isAssistantSpeaking && (signal.isUserSpeaking || signal.inputLevel > 0.2)) {
    return {
      phase: "listening",
      nextAction: "用户开口打断，停止输出，把控制权还给用户。",
      shouldInterrupt: true,
      confidence: Math.min(1, signal.inputLevel + 0.35)
    };
  }

  if (signal.isUserSpeaking || signal.inputLevel > 0.2) {
    return {
      phase: "listening",
      nextAction: "持续听用户说完，不抢话。",
      shouldInterrupt: false,
      confidence: Math.min(1, signal.inputLevel + 0.2)
    };
  }

  if (signal.silenceMs < silenceHoldMs) {
    const shouldBackchannel = signal.silenceMs >= Math.min(700, Math.round(silenceHoldMs * 0.6));
    return {
      phase: "holding",
      nextAction: `保持留白，等待用户自然补完。当前阈值 ${silenceHoldMs}ms。`,
      backchannel: shouldBackchannel ? "嗯，我在听。" : undefined,
      shouldInterrupt: false,
      confidence: 0.72
    };
  }

  if (session.turns.length === 0) {
    return {
      phase: "speaking",
      nextAction: session.card.suggestedOpening,
      shouldInterrupt: false,
      confidence: 0.82
    };
  }

  return {
    phase: "thinking",
    nextAction: "先镜像用户刚才的锚点，再提出一个追问。",
    shouldInterrupt: false,
    confidence: 0.8
  };
}

export function buildYearlyReview(state: ProductState): YearlyReview {
  const coreQuestions = state.questions.slice(0, 3).map((question) => question.question);
  const changedViews = state.points
    .filter((point) => point.status === "已修正" || point.status === "被挑战中")
    .slice(0, 3)
    .map((point) => point.title);
  const unresolvedPatterns = state.themes
    .filter((theme) => theme.maturity !== "关闭")
    .slice(0, 3)
    .map((theme) => `${theme.name}：${theme.nextQuestion}`);
  const importantDecisions = state.decisions.slice(0, 3).map((decision) => decision.title);
  const usedPerspectiveWords = state.notes.map((note) => `${note.summary} ${note.learnedTrack.join(" ")}`).join(" ");
  const missingPerspectives = ["哲学", "人类学", "叙事"].filter((perspective) => !usedPerspectiveWords.includes(perspective));

  return {
    coreQuestions,
    changedViews: changedViews.length > 0 ? changedViews : ["从“团队不主动”转向“机制是否让团队承担判断”。"],
    unresolvedPatterns,
    importantDecisions,
    missingPerspectives,
    nextYearFocus: "继续追踪控制感、授权机制和问题定义权之间的关系。"
  };
}

export type InterruptionScene = "key_insight" | "anchor_probe" | "perspective_shift" | "transition" | "backchannel";

export function getInterruptionScene(strategy?: string): InterruptionScene {
  switch (strategy) {
    case "blindspot_probe":
    case "mechanism_reversal_probe":
      return "key_insight";
    case "concrete_example_probe":
    case "debt_followup":
      return "anchor_probe";
    case "perspective_shift":
    case "synthesis":
      return "perspective_shift";
    case "mirror":
      return "transition";
    default:
      return "perspective_shift";
  }
}

export function buildInterruptionContext(params: {
  spokenSoFar: string;
  unspokenContent: string;
  strategy?: string;
  userInput: string;
}): string {
  const scene = getInterruptionScene(params.strategy);
  const spoken = params.spokenSoFar.trim();
  const unspoken = params.unspokenContent.trim();
  const user = params.userInput.trim();

  switch (scene) {
    case "key_insight":
      return "";
    case "anchor_probe":
      return [
        "【打断恢复 — 追问锚点】",
        `你刚才追问的核心问题是："${spoken}"`,
        unspoken ? `还没问完的部分："${unspoken}"` : "",
        `用户说："${user}"`,
        "请结合用户的新内容调整你的追问方式，但保持原问题的核心方向。先简短回应用户，再重新追问。"
      ].filter(Boolean).join("\n");
    case "perspective_shift":
      return [
        "【打断恢复 — 视角重构】",
        `你刚才表达的观点是："${spoken}"`,
        unspoken ? `还没说完的部分："${unspoken}"` : "",
        `用户说："${user}"`,
        "请先简短补充你之前未说完的观点（可以结合用户新说的内容调整表述），再回应当前问题。"
      ].filter(Boolean).join("\n");
    case "transition":
      return "";
    case "backchannel":
      return "";
    default:
      return "";
  }
}

const exportableId = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

export function createInterviewSession(params: { id: string; title: string; createdAt: string }): InterviewSession {
  return {
    id: params.id,
    mode: "daily",
    strength: "standard",
    status: "active",
    title: params.title,
    card: {
      title: params.title,
      whyNow: "",
      suggestedOpening: "今天从什么开始？",
      historyReferences: [],
      potentialTension: "",
      suggestedPerspectives: [],
      likelyOutputs: []
    },
    guide: {
      topicHint: params.title,
      dailyBrief: { suggestedTopic: params.title, openingQuestion: "今天从什么开始？", contextNote: "" },
      perspectiveCoverage: {},
      missingPerspectives: [],
      recommendedPerspectives: [],
      perspectiveRationale: "",
      relevantMemories: [],
      graphReferences: [],
      opinionEvolution: [],
      statedPositions: [],
      openDebts: [],
      blindspotCandidates: [],
      knowledgeFragments: [],
      suggestedOpening: "今天从什么开始？",
      strategyChecklist: []
    },
    turns: [],
    startedAt: params.createdAt
  };
}

export function addTurn(session: InterviewSession, input: { role: "user" | "assistant"; content: string; strategy?: string }): InterviewSession {
  return {
    ...session,
    turns: [
      ...session.turns,
      {
        id: exportableId("turn"),
        role: input.role,
        content: input.content,
        intent: input.role === "user" ? "用户表达" : (input.strategy ?? "追问"),
        timestamp: new Date().toISOString()
      }
    ]
  };
}

export interface InterviewAgentContext {
  instructions: string;
  sessionTitle: string;
  turnCount: number;
  latestUserTurn: string | null;
  history: Array<{ role: "user" | "assistant"; text: string }>;
  activeStrategies: string[];
}

export function buildInterviewAgentContext(session: InterviewSession): InterviewAgentContext {
  const instructions = buildRealtimeVoiceInstructions(session);
  const history: Array<{ role: "user" | "assistant"; text: string }> = [];
  for (const turn of session.turns) {
    if (turn.role === "user" || turn.role === "assistant") {
      history.push({ role: turn.role, text: turn.content });
    }
  }
  const lastUserTurn = [...session.turns].reverse().find(t => t.role === "user");
  const activeStrategies = session.enginePolicy?.appliedPlaybookRules?.slice(0, 5) ?? [];

  return {
    instructions,
    sessionTitle: session.title,
    turnCount: session.turns.length,
    latestUserTurn: lastUserTurn?.content ?? null,
    history: history.slice(-20),
    activeStrategies
  };
}
