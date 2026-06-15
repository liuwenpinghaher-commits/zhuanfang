// ============================================================================
// engine.ts — Barrel re-exports from domain modules + inline code for
// functions that have not yet been migrated into a dedicated module.
//
// Re-exports: all public symbols from the 12 domain modules so that existing
// imports like `import { ... } from "./engine"` continue to work.
// Inline: workflow orchestration, system-config versioning, quality reports,
// sanitization helpers, and search-brief utilities whose private-dependency
// trees cross module boundaries.
//
// To migrate one of the inline sections: move the export and its private
// helpers into the matching module, then update this file to re-export from
// that module instead.
// ============================================================================

// ---- Re-exports from domain modules ----------------------------------------

export {
  modeLabels, nowIso, makeId, cloneState, removedExternalInstruction,
  noQualityEvidenceScore, externalInstructionPatterns,
  withAuditEvent, withAiRunEvent, extractAnchor, isLongUserAnswer,
  buildMirroredFollowUp, summarizeUserAnswerForMirror, isMirroredFollowUp,
  trimFollowUp, shortUserQuote, findLastTurnIndex, findPendingControlAction,
  applyPendingControlToFollowUp, escapeRegExp, daysBetween,
  getReferenceMaterialPublisher, formatSearchTraceSourceLabel,
} from "./utils";

export {
  buildRealtimeVoiceInstructions,
} from "./voice-instructions";

export {
  addMemoryGraphToken, buildInterviewCard, buildInterviewContextPack,
  buildInterviewFollowUpQueue, buildInterviewGuide, buildInterviewResumeCard,
  buildMemoryEdgeLabel, buildMemoryEdgesForRecord, collectAppliedPlaybookRules,
  createSessionDraft, formatMemoryGraphTargetLabel, getMemoryGraphRelationLabel,
  tokenizeMemoryGraphText,
} from "./context-pack";

export {
  buildInterviewEnginePolicy, decideInterviewStrategy,
} from "./strategy";

export {
  addTurn, buildInterviewAgentContext, createInterviewSession,
  receiveUserTurn, receiveUserTurnWithAssistant, updateInterviewControl,
} from "./turn-builder";

export type {
  AddTurnInput, CreateInterviewSessionInput,
} from "./turn-builder";

export {
  finalizeSession,
  mergeFinalizedState,
} from "./finalize";

export type {
  FinalizeContent,
  FinalizeThemeUpsert,
} from "./finalize";

export {
  buildCognitiveRadar, buildMonthlyReview, buildYearlyReview,
} from "./review";

export {
  appendRealtimeSignalTrace, buildRealtimeTurnState, uniqueStrings,
  truncateAssistantTurn, buildInterruptionContext, getInterruptionScene,
  buildFallbackPreSignals,
} from "./signals";

export type {
  TruncateAssistantTurnInput,
  TruncateAssistantTurnResult,
  InterruptionScene,
} from "./signals";

export {
  buildProactiveSearchAgenda, buildSearchBrief,
  createKnowledgeDebtFromSearchBrief, createPointFromSearchBrief,
  createQuestionFromSearchBrief, createReadingAssetsFromSearchBrief,
  createSearchBriefFromInput, importReferenceMaterial,
} from "./search-brief";

export {
  approveMemoryCandidate, deleteMemoryRecord, deprecateMemoryRecord,
  rejectMemoryCandidate, updateMemoryCandidateText, updateMemoryRecordText,
} from "./memory";

export {
  confirmDecisionCandidate, createQuestionFromNote, markMemoryCorrection,
  searchProductAssets, submitInterviewFeedback, toggleAssetImportance,
  updateDecisionStatus, updateKnowledgeDebtStatus, updatePointStatus,
  updateQuestionStatus, updateReadingAssetStatus,
} from "./assets";

export {
  analyzeImportedInterview, approvePlaybookPatch, formatCorpusMoveLabel,
  revertPlaybookPatch,
} from "./corpus";

export {
  generatePodcastEpisode, generatePodcastEpisodeFromCorpusInsight,
  generatePodcastEpisodeFromKnowledgeDebt, generatePodcastEpisodeFromSearchBrief,
  generatePodcastEpisodeFromTheme,
} from "./podcast";

// ============================================================================
// Inline code — functions still resident in engine.ts.
// These need DIRECT imports because barrel `export {} from` doesn't create
// local bindings that inline code below can reference.
// ============================================================================

import { withAiRunEvent, withAuditEvent, nowIso, makeId } from "./utils";
import { buildInterviewContextPack } from "./context-pack";
import { initialProductState } from "./seed";
import type {
  AssetStatus,
  AuditEvent,
  AiRunEvent,
  CognitiveRadar,
  ConfigVersion,
  CorpusImportInput,
  CorpusInsight,
  CorpusTurn,
  InterviewCard,
  InterviewContextPack,
  InterviewControlAction,
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
  YearlyReview,
} from "./types";

// ============================================================================
// Section A: Workflow orchestration
// ============================================================================

export function triggerWorkflowRun(
  state: ProductState, input: TriggerWorkflowRunInput
): { run: WorkflowRun; nextState: ProductState } {
  const startedAt = new Date().toISOString();
  const workflowRunId = `workflow-run-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const completedAt = new Date().toISOString();
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
    metadata: workflowMetadata,
  };
  const stateWithRun: ProductState = {
    ...state,
    workflowRuns: [run, ...(state.workflowRuns ?? [])],
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
    createdAt: completedAt,
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
          createdAt: completedAt,
        })
      : stateWithAiRun;

  return { run, nextState };
}

export function withGeneratedArtifactWorkflowRun(
  state: ProductState, input: TriggerWorkflowRunInput
): ProductState {
  return triggerWorkflowRun(state, input).nextState;
}

export function refreshWorkflowRunDetails(
  state: ProductState, input: TriggerWorkflowRunInput
): ProductState {
  const existingRun = (state.workflowRuns ?? []).find(
    (run) =>
      run.workflow === input.workflow &&
      run.entityType === input.entityType &&
      run.entityId === input.entityId,
  );
  if (!existingRun) {
    return triggerWorkflowRun(state, input).nextState;
  }

  const completedAt = new Date().toISOString();
  const workflowDetails = buildWorkflowRunDetails(state, input);
  const refreshedRun: WorkflowRun = {
    ...existingRun,
    outputSummary: workflowDetails.outputSummary,
    completedAt,
    metadata: workflowDetails.metadata,
  };

  return {
    ...state,
    workflowRuns: state.workflowRuns.map((run) =>
      run.id === existingRun.id ? refreshedRun : run,
    ),
    aiRunEvents: state.aiRunEvents.map((event) =>
      event.workflowRunId === existingRun.id
        ? { ...event, outputSummary: workflowDetails.outputSummary }
        : event,
    ),
  };
}

function buildWorkflowRunDetails(
  state: ProductState, input: TriggerWorkflowRunInput,
): Pick<WorkflowRun, "outputSummary" | "metadata"> {
  if (input.workflow === "context_pack_build") {
    const session =
      input.entityType === "interview_session"
        ? state.sessions.find((item) => item.id === input.entityId)
        : undefined;
    const topicHint =
      session?.guide.topicHint || session?.title || state.themes[0]?.name || state.profile.currentFocus;
    const contextPack = buildInterviewContextPack(state, {
      topicHint,
      ...(session?.card.searchBriefId ? { searchBriefId: session.card.searchBriefId } : {}),
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
        (interception) => interception.severity === "critical",
      ).length,
      sourceCount: contextPack.sources.length,
    };

    return {
      outputSummary:
        `ContextPack 已构建：主题「${contextPack.topicHint}」，` +
        `${metadata.confirmedMemoryCount} 条确认记忆，${metadata.pendingCandidateCount} 条待审候选，` +
        `${metadata.memoryEdgeCount} 条记忆图谱边，${metadata.searchBriefCount} 份外部资料，${metadata.ragChunkCount} 个 RAG 分块，` +
        `${metadata.sourceCount} 个来源，${metadata.securityInterceptionCount} 项安全拦截。`,
      metadata,
    };
  }

  if (input.workflow === "memory_projection") {
    const session =
      input.entityType === "interview_session"
        ? state.sessions.find((item) => item.id === input.entityId)
        : undefined;
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
      modelContextRecordCount: contextPack.memoryRecords.length,
    };

    return {
      outputSummary:
        `MemoryProjection 已完成：${metadata.pendingCandidateCount} 条待审候选，` +
        `${metadata.confirmedRecordCount} 条确认长期记忆，${metadata.sensitiveCandidateCount} 条敏感候选。`,
      metadata,
    };
  }

  if (input.workflow === "search_brief_generation") {
    const brief =
      input.entityType === "search_brief"
        ? state.searchBriefs.find((item) => item.id === input.entityId)
        : undefined;
    if (brief) {
      const metadata = {
        topic: brief.topic,
        provider: brief.provider,
        sourceCount: brief.sources.length,
        factCount: brief.facts.length,
        controversyCount: brief.controversies.length,
        discussionTopicCount: brief.discussionTopics.length,
        needsReview: brief.status === "needs-review",
      };

      return {
        outputSummary:
          `SearchBrief 已同步：主题「${brief.topic}」，${metadata.factCount} 条事实，` +
          `${metadata.sourceCount} 个来源，${metadata.discussionTopicCount} 个讨论主题。`,
        metadata,
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
        audioRendered: episode.audioRenderStatus === "rendered",
      };

      return {
        outputSummary:
          `PodcastGeneration 已同步：${episode.title}，预计 ${episode.durationSec} 秒，` +
          `${metadata.chapterCount} 个章节，${metadata.shownoteCount} 条 shownotes。`,
        metadata,
      };
    }
  }

  if (input.workflow === "import_ingestion") {
    const importSource =
      input.entityType === "import_source"
        ? state.importSources.find((item) => item.id === input.entityId)
        : undefined;
    if (importSource) {
      const metadata = {
        title: importSource.title,
        sourceType: importSource.sourceType,
        chunkCount: importSource.chunkIds.length,
        searchBriefId: importSource.searchBriefId,
        sourceUrlConfigured: Boolean(importSource.sourceUrl),
        sensitivity: importSource.sensitivity,
      };

      return {
        outputSummary:
          `ImportIngestion 已同步：${importSource.title}，${metadata.chunkCount} 个 RAG 分块，` +
          `资料包 ${importSource.searchBriefId} 可带入专访。`,
        metadata,
      };
    }

    const corpusImport =
      input.entityType === "corpus_import"
        ? state.corpusImports.find((item) => item.id === input.entityId)
        : undefined;
    const insight = corpusImport
      ? state.corpusInsights.find((item) => item.importId === corpusImport.id)
      : undefined;
    if (corpusImport) {
      const metadata = {
        title: corpusImport.title,
        mediaType: corpusImport.mediaType,
        turnCount: corpusImport.turns.length,
        dimensionCount: insight?.dimensions.length ?? 0,
        patchCount: insight?.recommendedPatches.length ?? 0,
        sourceUrlConfigured: Boolean(corpusImport.sourceUrl),
      };

      return {
        outputSummary:
          `ImportIngestion 已同步：${corpusImport.title}，${metadata.turnCount} 个转写轮次，` +
          `${metadata.dimensionCount} 个分析维度，${metadata.patchCount} 个 PlaybookPatch。`,
        metadata,
      };
    }
  }

  if (input.workflow === "reference_interview_learning") {
    const corpusImport =
      input.entityType === "corpus_import"
        ? state.corpusImports.find((item) => item.id === input.entityId)
        : undefined;
    const insight = corpusImport
      ? state.corpusInsights.find((item) => item.importId === corpusImport.id)
      : undefined;
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
        ruleCount: patches.reduce((count, patch) => count + patch.rules.length, 0),
      };

      return {
        outputSummary:
          `ReferenceInterviewLearning 已同步：${corpusImport.title}，${metadata.dimensionCount} 个分析维度，` +
          `${metadata.patchCount} 个 PlaybookPatch，${metadata.appliedPatchCount} 个已影响引擎。`,
        metadata,
      };
    }
  }

  return {
    outputSummary: buildWorkflowOutputSummary(input.workflow),
    metadata: { runtime: "local-workflow-runtime" },
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
    reference_interview_learning: "已完成专访样本学习 workflow run。",
  };
  return summaries[workflow];
}

// ============================================================================
// Section B: CreateSessionOptions / createInitialProductState
// ============================================================================

export interface CreateSessionOptions {
  searchBriefId?: string;
  topicHint?: string;
}

export function createInitialProductState(): ProductState {
  return JSON.parse(JSON.stringify(initialProductState)) as ProductState;
}

// ============================================================================
// Section C: External-material sanitization
// ============================================================================

const removedExternalInstruction = "[已移除外部指令片段]";

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
  /leak\s+(?:api\s*key|secret|password)/gi,
];

export function sanitizeExternalMaterialText(text: string, fallback: string) {
  let sanitized = text.trim();
  for (const pattern of externalInstructionPatterns) {
    sanitized = sanitized.replace(pattern, removedExternalInstruction);
  }
  sanitized = sanitized
    .replace(
      new RegExp(`(?:${removedExternalInstruction.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*){2,}`, "g"),
      `${removedExternalInstruction} `,
    )
    .replace(/\s+/g, " ")
    .trim();
  return sanitized || fallback;
}

export function sanitizeExternalMaterialBlock(text: string, fallback: string) {
  const lines = text
    .split(/\n+/)
    .map((line) => sanitizeExternalMaterialText(line, fallback))
    .filter(Boolean);
  return lines.length > 0 ? lines.join("\n") : fallback;
}

export function sanitizeExternalMaterialList(items: string[], fallback: string) {
  return items.map((item) => sanitizeExternalMaterialText(item, fallback)).filter(Boolean);
}

export function sanitizeExternalSource(source: SourceHighlight): SourceHighlight {
  return {
    ...source,
    title: sanitizeExternalMaterialText(source.title, "已清洗的外部资料标题"),
    publisher: sanitizeExternalMaterialText(source.publisher, "来源待确认"),
    snippet: sanitizeExternalMaterialText(source.snippet, "外部资料片段已清洗，需回到原始来源核验。"),
  };
}

// ============================================================================
// Section D: Search-brief text helpers
// ============================================================================

export function pickSearchBriefText(values: string[], fallback: string) {
  const value = values.find((item) => item.trim());
  return sanitizeExternalMaterialText(value ?? fallback, fallback);
}

export function formatSearchBriefSourceLabel(brief: SearchBrief) {
  const source = brief.sources[0];
  if (!source) {
    return brief.provider;
  }
  return `${source.publisher}｜${source.title}`;
}

export function buildSearchBriefSourceEvidence(brief: SearchBrief) {
  return brief.sources.slice(0, 3).map((source) => `来源：${source.publisher}｜${source.title}｜${source.url}`);
}

export function resolveSearchBriefThemeIds(state: ProductState, brief: SearchBrief) {
  const corpus = [brief.topic, brief.summary, ...brief.discussionTopics, ...brief.interviewAngles].join(" ");
  const matched = state.themes
    .filter((theme) => {
      const summarySignal = theme.summary.trim().slice(0, 8);
      return corpus.includes(theme.name) || (summarySignal.length >= 4 && corpus.includes(summarySignal));
    })
    .map((theme) => theme.id);
  return matched.length > 0 ? matched.slice(0, 2) : state.themes.slice(0, 1).map((theme) => theme.id);
}

// ============================================================================
// Section E: Interview-quality report
// ============================================================================

export function buildInterviewQualityReport(session: InterviewSession): InterviewQualityReport {
  const trace = session.strategyTrace ?? [];
  const perspectivesUsed = Array.from(
    new Set(trace.map((item) => item.perspective).filter((item): item is string => Boolean(item))),
  );
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
      "避免专访只在单一解释框架里循环。",
    ),
    buildQualityGate(
      "debt_followup",
      "知识债回访",
      trace.some((item) => item.strategy === "debt_followup"),
      "至少回访 1 个未完成知识债",
      trace.some((item) => item.strategy === "debt_followup") ? "已回访" : "未回访",
      "保证会话不是孤立聊天，而是延续长期学习线索。",
    ),
    buildQualityGate(
      "blindspot_probe",
      "盲区探测",
      trace.some((item) => item.strategy === "blindspot_probe"),
      "至少引入 1 个盲区候选",
      trace.find((item) => item.strategy === "blindspot_probe")?.blindspotConcept ?? "未触达",
      "让访谈能挑战用户尚未主动提到的解释维度。",
    ),
    buildQualityGate(
      "history_reference_rate",
      "历史引用率",
      historyReferenceRate >= 1,
      "视角提问 100% 引用历史",
      `${Math.round(historyReferenceRate * 100)}%`,
      "每次视角切换都必须落回用户自己的历史材料。",
    ),
    buildQualityGate(
      "meta_depth",
      "元认知深度",
      depthsReached.includes("meta") || depthsReached.includes("synthesis"),
      "至少触达 1 次元认知或综合层",
      depthsReached.join(" / ") || "无",
      "真正的专访需要从事实推进到机制和自我观察。",
    ),
    buildQualityGate(
      "forbidden_terms",
      "禁用客服化表达",
      forbiddenTerms.length === 0,
      "禁用词 0 次",
      forbiddenTerms.length === 0 ? "0 次" : forbiddenTerms.join(" / "),
      "避免输出像客服、免责声明或模型自述。",
    ),
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
    generatedAt: new Date().toISOString(),
  };
}

function buildRealtimeTurnTakingGate(
  session: InterviewSession,
): InterviewQualityReport["gates"][number] | undefined {
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
    "用实时信号验证短暂停顿留白、用户打断交还控制权、语音追问可追溯。",
  );
}

// ============================================================================
// Section F: Quality-operations report
// ============================================================================

export function buildQualityOperationsReport(state: ProductState): QualityOperationsReport {
  const completedSessions = state.sessions.filter((session) => session.status === "completed");
  const qualityScores = completedSessions.map(
    (session) => session.qualityReport?.score ?? buildInterviewQualityReport(session).score,
  );
  const assistantTurns = state.sessions.flatMap((session) => session.turns.filter((turn) => turn.role === "assistant"));
  const referencedAssistantTurns = assistantTurns.filter((turn) => Boolean(turn.referencedMemory));
  const strategyTraces = completedSessions.flatMap((session) => session.strategyTrace ?? []);
  const meaningfulFollowups = strategyTraces.filter((item) =>
    [
      "debt_followup",
      "perspective_shift",
      "blindspot_probe",
      "mechanism_reversal_probe",
      "premise_challenge",
      "synthesis",
    ].includes(item.strategy),
  );
  const forbiddenTerms = completedSessions.flatMap((session) => session.qualityReport?.forbiddenTerms ?? []);
  const searchBriefsWithSources = state.searchBriefs.filter((brief) => brief.sources.length > 0);
  const contextPackEvidence = scoreContextPackRelevance(state);
  const memoryCandidatePrecisionScore = scoreMemoryCandidatePrecision(state);
  const playbookComparisons = buildPlaybookQualityComparisons(completedSessions);
  const metrics = [
    buildQualityOperationsMetric(
      "interview_naturalness",
      "专访自然度",
      qualityScores.length > 0 ? average(qualityScores) : 70,
      "完成会话平均质量分 >= 80",
      qualityScores.length > 0
        ? `${qualityScores.length} 个完成会话，平均 ${average(qualityScores)} 分。`
        : "还没有完成会话质量分。",
    ),
    buildQualityOperationsMetric(
      "followup_relevance",
      "追问相关性",
      strategyTraces.length > 0
        ? Math.round((meaningfulFollowups.length / strategyTraces.length) * 100)
        : 70,
      "至少 70% 追问进入机制、视角、盲区或总结层",
      strategyTraces.length > 0
        ? `${meaningfulFollowups.length}/${strategyTraces.length} 个策略动作进入深层追问。`
        : "还没有策略轨迹可评估。",
    ),
    buildQualityOperationsMetric(
      "memory_citation",
      "记忆引用",
      assistantTurns.length > 0
        ? Math.round((referencedAssistantTurns.length / assistantTurns.length) * 100)
        : 70,
      "助手追问引用历史或上下文 >= 80%",
      assistantTurns.length > 0
        ? `${referencedAssistantTurns.length}/${assistantTurns.length} 个助手回合带有引用。`
        : "还没有助手回合可评估。",
    ),
    buildQualityOperationsMetric(
      "context_pack_relevance",
      "ContextPack 相关性",
      contextPackEvidence.score,
      "会话或 ContextPack workflow 必须带入主题相关记忆、来源或图谱依据",
      contextPackEvidence.detail,
    ),
    buildQualityOperationsMetric(
      "memory_candidate_precision",
      "候选记忆精度",
      memoryCandidatePrecisionScore.score,
      "已审核候选中用户确认率 >= 80%，pending 候选需要及时处理",
      memoryCandidatePrecisionScore.detail,
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
          : "未发现禁用表达或记忆污染信号。",
    ),
    buildQualityOperationsMetric(
      "source_faithfulness",
      "来源忠实度",
      state.searchBriefs.length > 0
        ? Math.round((searchBriefsWithSources.length / state.searchBriefs.length) * 100)
        : 100,
      "进入系统的联网素材必须保留来源",
      state.searchBriefs.length > 0
        ? `${searchBriefsWithSources.length}/${state.searchBriefs.length} 份搜索简报保留来源。`
        : "还没有联网素材，暂未触发来源风险。",
    ),
  ] satisfies QualityOperationsReport["metrics"];
  const risks = buildQualityRisks(state, metrics);
  const remediationActions = buildAllRemediationActions(state, metrics, playbookComparisons);

  return {
    generatedAt: new Date().toISOString(),
    overallScore: Math.round(average(metrics.map((metric) => metric.score))),
    metrics,
    playbookComparisons,
    recentAuditEvents: (state.auditEvents ?? []).slice(0, 6),
    recentAiRunEvents: (state.aiRunEvents ?? []).slice(0, 6),
    risks,
    remediationActions,
  };
}

// ============================================================================
// Section G: Interview-transparency report
// ============================================================================

export function buildInterviewTransparencyReport(
  state: ProductState, limit = 3,
): InterviewTransparencyItem[] {
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
          .filter((reference): reference is string => Boolean(reference)),
      ])
        .filter((reference) => !isAgendaHistoryReference(reference))
        .slice(0, 4);
      const playbookReferences = buildSessionPlaybookReferences(state, session);
      const degradedEvents = state.aiRunEvents
        .filter(
          (event) =>
            event.entityType === "interview_session" &&
            event.entityId === session.id &&
            event.status === "degraded",
        )
        .map((event) => ({
          workflow: event.workflow,
          providerId: event.providerId,
          reason: event.degradedReason ?? event.outputSummary,
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
                seedAssetIds: linkedSearchBrief.agendaTrace.seedAssetIds,
              },
            ]
          : [],
        memoryReferences,
        playbookReferences,
        playbookVersion: session.enginePolicy?.playbookVersion ?? state.systemConfig.interview.playbookVersion,
        interviewModel: state.systemConfig.models.interviewModel,
        strategyReasons: (session.strategyTrace ?? [])
          .map((decision) => `${decision.label}：${decision.reason}`)
          .slice(0, 4),
        controls: session.turns
          .filter((turn) => turn.intent === "控制反馈")
          .map((turn) => summarizeControlFeedback(turn.content)),
        realtimeSignals: (session.realtimeSignals ?? [])
          .slice(-4)
          .map(formatRealtimeSignalTrace),
        degradedEvents,
      };
    });
}

// ---- Private helpers for transparency + quality reports --------------------

function buildSessionPlaybookReferences(
  state: ProductState, session: InterviewSession,
): InterviewTransparencyItem["playbookReferences"] {
  return state.playbookPatches
    .filter((patch) => patch.status === "applied")
    .map((patch) => ({
      id: patch.id,
      patchId: patch.id,
      title: patch.title,
      status: patch.status,
      sourceInsightId: patch.sourceInsightId ?? patch.id,
      rules: patch.rules,
      impact: patch.impact,
    })) as InterviewTransparencyItem["playbookReferences"];
}

function isAgendaHistoryReference(reference: string) {
  return /^议程：/.test(reference);
}

function formatRealtimeSignalTrace(signal: RealtimeSessionSignal) {
  const parts: string[] = [
    `[${signal.eventType === "hold" ? "留白" : signal.eventType === "interruption" ? "打断" : "语音追问"}]`,
    `阶段：${signal.phase === "holding" ? "留白中" : signal.phase === "listening" ? "收听中" : signal.phase === "thinking" ? "思考中" : "讲话中"}`,
    signal.transcript?.trim() ? `转写：${signal.transcript.trim().slice(0, 30)}` : "",
  ].filter(Boolean);
  return parts.join("，");
}

function summarizeControlFeedback(content: string) {
  const cleanup = content
    .replace(/^用户控制反馈：/i, "")
    .replace(/^控制反馈：/i, "")
    .replace(/^收听控制反馈：/i, "")
    .trim();
  return cleanup || "控制反馈";
}

function buildQualityOperationsMetric(
  id: QualityOperationsReport["metrics"][number]["id"],
  label: string,
  score: number,
  target: string,
  detail: string,
): QualityOperationsReport["metrics"][number] {
  return { id, label, score, target, detail, status: score >= 80 ? "pass" as const : score >= 60 ? "watch" as const : "risk" as const };
}

function buildQualityRisks(
  state: ProductState,
  metrics: QualityOperationsReport["metrics"],
): string[] {
  const risks: string[] = [];
  for (const metric of metrics) {
    if (metric.score < 60) {
      risks.push(`${metric.label} 风险 — ${metric.detail}。建议：提升 "${metric.label}" 是当前优先级最高的质量优化方向。`);
    } else if (metric.score < 80) {
      risks.push(`${metric.label} 待提升 — ${metric.detail}。建议：关注 "${metric.label}" 的持续改善路径。`);
    }
  }

  const buildFailureState = findFailedRealtimeTurnTakingGate(state);
  if (buildFailureState) {
    risks.push(`构建流程异常 — ${buildFailureState}。建议：检查最近一次 ContextPack 构建流程的异常原因。`);
  }

  return risks;
}

function buildQualityGuardrails(state: ProductState) {
  const guards: string[] = [];
  if (state.systemConfig.memory.includeSensitiveMemoriesInContext) {
    guards.push("敏感长期记忆已允许进入模型上下文，每次追问前检查引用透明度。");
  }
  if (state.systemConfig.memory.includePendingCandidatesInContext) {
    guards.push("待审核记忆候选已允许进入模型上下文，确保引用时注明候选状态。");
  }
  if (state.memoryCandidates.some((candidate) => candidate.status === "pending" && candidate.sensitivity === "sensitive")) {
    guards.push("存在敏感待审候选，不将其带入模型上下文。");
  }
  return guards;
}

function buildRemediationAction(
  state: ProductState,
  metricId: QualityOperationsReport["metrics"][number]["id"],
  source: string,
  priority: "high" | "medium" | "low",
  label: string,
  description: string,
): QualityRemediationAction {
  return {
    id: `remediate-${metricId}-${state.systemConfig.version}`,
    sourceMetricId: metricId,
    priority,
    owner: "interview_director" as const,
    title: label,
    action: description,
    evidence: "",
    nextInterviewInstruction: "",
  };
}

function buildAllRemediationActions(
  state: ProductState,
  metrics: QualityOperationsReport["metrics"],
  playbookComparisons: QualityOperationsReport["playbookComparisons"],
): QualityRemediationAction[] {
  const allActions: QualityRemediationAction[] = [];

  for (const metric of metrics) {
    if (metric.score >= 80) continue;

    if (metric.id === "interview_naturalness" && metric.score < 70) {
      allActions.push(buildRemediationAction(state, "interview_naturalness", "quality-remediation", "high", "降低追问密度，增加留白", "自然度偏低，先检查本轮策略轨迹中是否追问过于频繁或没有给用户留卡顿空间。"));
    }
    if (metric.id === "memory_citation") {
      allActions.push(buildRemediationAction(state, "memory_citation", "quality-remediation", metric.score < 60 ? "high" : "medium", "增强历史引用", "记忆引用率偏低，确保 ContextPack 构建时带上历史相关记忆和知识债。"));
    }
    if (metric.id === "context_pack_relevance" && metric.score < 70) {
      allActions.push(buildRemediationAction(state, "context_pack_relevance", "quality-remediation", "high", "补充 ContextPack 相关性", "ContextPack 主题相关记忆或来源不足，检查 topicHint 和 searchBrief 是否完整传入。"));
    }
    if (metric.id === "memory_candidate_precision" && metric.score < 70) {
      allActions.push(buildRemediationAction(state, "memory_candidate_precision", "quality-remediation", "medium", "提高候选记忆精度", "候选记忆精度偏低，检查候选记忆是否过多、重复或敏感。"));
    }
  }

  if (metrics.find((m) => m.id === "sensitive_leakage")?.score === 0) {
    allActions.push(buildRemediationAction(state, "sensitive_leakage", "quality-remediation", "high", "立即检查禁用客服化表达", '系统检测到 AI 问答中出现了"作为AI"或"免责声明"等禁用表达，这会破坏用户对被访角色的信任。'));
  }

  const promoteAction = playbookComparisons.find((row) => row.recommendation === "promote");
  if (promoteAction) {
    allActions.push(buildRemediationAction(state, "followup_relevance", "playbook-optimizer", "low", `考虑提升 Playbook 版本 ${promoteAction.playbookVersion}`, `该版本平均质量分 ${promoteAction.averageQualityScore}，比当前版本高 ${promoteAction.deltaFromBaseline} 分。`));
  }

  const rollbackAction = playbookComparisons.find((row) => row.recommendation === "rollback");
  if (rollbackAction) {
    allActions.push(buildRemediationAction(state, "interview_naturalness", "playbook-optimizer", "high", `考虑回滚 Playbook 版本 ${rollbackAction.playbookVersion}`, `该版本平均质量分 ${rollbackAction.averageQualityScore}，比当前版本低 ${Math.abs(rollbackAction.deltaFromBaseline)} 分。`));
  }

  return uniqueQualityRemediationActions(allActions);
}

function uniqueQualityRemediationActions(actions: QualityRemediationAction[]) {
  return [...new Map(actions.map((action) => [action.id, action])).values()].sort(
    (a, b) => priorityRank(a.priority) - priorityRank(b.priority),
  );
}

function priorityRank(priority: QualityRemediationAction["priority"]) {
  return priority === "high" ? 0 : priority === "medium" ? 1 : 2;
}

function findFailedRealtimeTurnTakingGate(state: ProductState) {
  const recentBuilds = state.workflowRuns.filter(
    (run) => run.workflow === "context_pack_build" || run.workflow === "memory_projection",
  );
  const failedBuild = recentBuilds.find((build) => build.status === "failed");
  if (failedBuild) {
    return `最近一次 ${failedBuild.workflow} workflow 失败：${failedBuild.outputSummary}`;
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
  detail: string,
  remediation: string,
): InterviewQualityReport["gates"][number] {
  return { id, label, passed, target, actual: passed ? "达标" : "未达标", detail: `${detail} ${remediation}` };
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
    const memoryCount =
      numericMetadata(metadata, "confirmedMemoryCount") + numericMetadata(metadata, "memoryRecordCount");
    const sourceCount =
      numericMetadata(metadata, "sourceHighlightCount") + numericMetadata(metadata, "ragChunkCount");
    const graphCount = numericMetadata(metadata, "graphReferenceCount");
    return (
      typeof metadata.topicHint === "string" &&
      metadata.topicHint.trim().length > 0 &&
      memoryCount + sourceCount + graphCount > 0
    );
  });
  const evidenceTotal = state.sessions.length + contextPackRuns.length;
  const relevantTotal = sessionsWithContext.length + relevantContextPackRuns.length;

  if (evidenceTotal === 0) {
    return { score: 70, detail: "还没有会话或 ContextPack workflow 可评估。" };
  }

  return {
    score: Math.round((relevantTotal / evidenceTotal) * 100),
    detail: `${sessionsWithContext.length}/${state.sessions.length} 个会话具备上下文依据，${relevantContextPackRuns.length}/${contextPackRuns.length} 个 ContextPack workflow 带有主题相关证据。`,
  };
}

function scoreMemoryCandidatePrecision(state: ProductState) {
  const approvedCount = state.memoryCandidates.filter((candidate) => candidate.status === "approved").length;
  const rejectedCount = state.memoryCandidates.filter((candidate) => candidate.status === "rejected").length;
  const pendingCount = state.memoryCandidates.filter((candidate) => candidate.status === "pending").length;
  const reviewedCount = approvedCount + rejectedCount;

  if (reviewedCount === 0) {
    return {
      score: pendingCount > 0 ? 50 : 100,
      detail: pendingCount > 0 ? `还没有已审核候选，${pendingCount} 个仍待审核。` : "还没有候选记忆进入审核，暂未触发精度风险。",
    };
  }

  return {
    score: Math.round((approvedCount / reviewedCount) * 100),
    detail: `${approvedCount}/${reviewedCount} 个已审核候选被确认，${pendingCount} 个仍待审核。`,
  };
}

function numericMetadata(metadata: Record<string, string | number | boolean>, key: string) {
  const value = metadata[key];
  return typeof value === "number" ? value : 0;
}

function buildPlaybookQualityComparisons(
  completedSessions: InterviewSession[],
): QualityOperationsReport["playbookComparisons"] {
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
      recommendation: "watch" as const,
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
        recommendation: recommendPlaybookVersion(row.averageQualityScore, deltaFromBaseline),
      };
    })
    .sort(
      (a, b) => b.averageQualityScore - a.averageQualityScore || a.playbookVersion.localeCompare(b.playbookVersion),
    );
}

function recommendPlaybookVersion(
  averageQualityScore: number,
  deltaFromBaseline: number,
): QualityOperationsReport["playbookComparisons"][number]["recommendation"] {
  if (deltaFromBaseline >= 10 && averageQualityScore >= 80) {
    return "promote";
  }
  if (deltaFromBaseline <= -10 || averageQualityScore < 60) {
    return "rollback";
  }
  return "watch";
}

function uniqueStrings(values: string[]) {
  return [...new Set(values)];
}

// ============================================================================
// Section H: System-config versioning
// ============================================================================

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
      : "当前引擎使用 base-v1 访谈策略。",
  ];

  return {
    configVersion: state.systemConfig.version,
    activeProviders: {
      search: activeSearch,
      voice: voiceProvider,
      interviewModel: state.systemConfig.models.interviewModel,
    },
    providers: state.systemConfig.providers,
    observations,
  };
}

export function removeVersionSuffix(version: string, suffix: string) {
  return version.split(suffix).join("");
}

export function applySystemConfigChange(
  state: ProductState,
  nextConfig: SystemConfig,
  options: { changedBy: ConfigVersion["changedBy"]; reason: string },
): ProductState {
  const createdAt = new Date().toISOString();
  const nextState = withSystemConfigVersion(state, nextConfig, { ...options, createdAt });
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
    createdAt,
  });
}

export function rollbackSystemConfigVersion(state: ProductState, versionId: string): ProductState {
  const history = ensureConfigVersionHistory(state);
  const targetVersion = history.find((version) => version.id === versionId);
  if (!targetVersion) {
    return state;
  }

  const createdAt = new Date().toISOString();
  const nextState = withSystemConfigVersion(state, targetVersion.snapshot, {
    changedBy: "user",
    reason: `回滚到配置版本 ${targetVersion.version}`,
    createdAt,
    rollbackTarget: targetVersion.version,
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
    createdAt,
  });
}

export function withSystemConfigVersion(
  state: ProductState,
  nextConfig: SystemConfig,
  options: {
    changedBy: ConfigVersion["changedBy"];
    reason: string;
    createdAt: string;
    rollbackTarget?: string;
  },
): ProductState {
  const nextConfigWithVersion = ensureNextConfigVersion(state.systemConfig, nextConfig, options.createdAt);
  const diff = describeSystemConfigDiff(state.systemConfig, nextConfigWithVersion);
  if (diff.length === 0 && state.systemConfig.version === nextConfigWithVersion.version) {
    return state;
  }

  const history = ensureConfigVersionHistory(state).map((version) => ({
    ...version,
    active: false,
  }));
  const versionRecord: ConfigVersion = {
    id: `cfgv-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    version: nextConfigWithVersion.version,
    createdAt: options.createdAt,
    changedBy: options.changedBy,
    reason: options.reason,
    diff,
    active: true,
    rollbackTarget: options.rollbackTarget ?? state.systemConfig.version,
    affectedSessions: state.sessions.map((session) => session.id),
    snapshot: cloneConfig(nextConfigWithVersion),
  };

  return {
    ...(JSON.parse(JSON.stringify(state)) as ProductState),
    systemConfig: nextConfigWithVersion,
    configVersions: [versionRecord, ...history],
  };
}

function ensureNextConfigVersion(
  previousConfig: SystemConfig,
  nextConfig: SystemConfig,
  createdAt: string,
): SystemConfig {
  if (nextConfig.version !== previousConfig.version) {
    return cloneConfig(nextConfig);
  }

  return {
    ...cloneConfig(nextConfig),
    version: `${previousConfig.version}+cfg-${new Date(createdAt).getTime().toString(36)}`,
  };
}

function ensureConfigVersionHistory(state: ProductState): ConfigVersion[] {
  if (state.configVersions.length > 0) {
    return state.configVersions;
  }

  return [
    {
      id: `cfgv-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      version: state.systemConfig.version,
      createdAt: new Date().toISOString(),
      changedBy: "system",
      reason: "初始配置基线",
      diff: [],
      active: true,
      affectedSessions: state.sessions.map((session) => session.id),
      snapshot: JSON.parse(JSON.stringify(state.systemConfig)) as SystemConfig,
    },
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

  return Object.entries(value as Record<string, unknown>).reduce<Record<string, string>>(
    (flattened, [key, nestedValue]) => {
      if (key === "version") {
        return flattened;
      }
      const path = prefix ? `${prefix}.${key}` : key;
      if (Array.isArray(nestedValue)) {
        flattened[path] = JSON.stringify(nestedValue);
        return flattened;
      }
      if (nestedValue && typeof nestedValue === "object") {
        return { ...flattened, ...flattenConfig(nestedValue, path) };
      }
      flattened[path] = String(nestedValue ?? "");
      return flattened;
    },
    {},
  );
}

function cloneConfig(config: SystemConfig): SystemConfig {
  return JSON.parse(JSON.stringify(config)) as SystemConfig;
}
