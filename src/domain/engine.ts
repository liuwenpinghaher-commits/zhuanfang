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
  sanitizeExternalMaterialText, sanitizeExternalMaterialBlock,
  sanitizeExternalMaterialList, sanitizeExternalSource, pickSearchBriefText,
} from "./utils";

export {
  buildRealtimeVoiceInstructions,
} from "./voice-instructions";

export {
  addMemoryGraphToken, buildInterviewCard, buildInterviewContextPack,
  buildInterviewGuide,
  buildInterviewResumeCard,
  buildInterviewResumeCards,
  resolveInterviewTopicHint,
  collectAppliedPlaybookRules,
  computeRecordThemeIds,
  createSessionDraft, formatMemoryGraphTargetLabel,
  tokenizeMemoryGraphText,
} from "./context-pack";

export {
  buildCognitiveRevisitQueue,
  countPendingMemoryCandidates,
  pickInterviewLaunchRecommendation,
  listDueDecisionsForRevisit,
  revisitSuppressKey,
  isRevisitSuppressed,
  suppressRevisitOnSession,
} from "./revisit-queue";

export type {
  RevisitItem,
  RevisitKind,
  InterviewLaunchRecommendation,
} from "./revisit-queue";

export {
  buildInterviewEnginePolicy, decideInterviewStrategy,
  overlayThinHostStrategy, isSpaceHoldingUserText, isThinHostReply,
} from "./strategy";

export {
  addTurn, buildInterviewAgentContext, createInterviewSession,
  receiveUserTurn, receiveUserTurnWithAssistant, appendUserTurnOnly, appendAssistantTurn,
  applyTurnPatch, updateInterviewControl,
  INTERVIEW_STRATEGY_LABELS, PLAYBOOK_DRIVEN_STRATEGIES,
} from "./turn-builder";

export { appendAssistantTranscriptFinal } from "./session-transcript";

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
  createQuestionFromSearchBrief,
  createSearchBriefFromInput,
} from "./search-brief";

export {
  approveMemoryCandidate, dedupeMemoryRecords, deleteMemoryRecord, deprecateMemoryRecord,
  planMemoryUpdate, rejectMemoryCandidate, updateMemoryCandidateText, updateMemoryRecordText,
} from "./memory";

export {
  confirmDecisionCandidate, searchProductAssets, toggleAssetImportance,
  updateDecisionStatus, updateKnowledgeDebtStatus, updatePointStatus,
  updateQuestionStatus,
} from "./assets";
export {
  createQuestionFromNote, markMemoryCorrection,
} from "./note-feedback";

export {
  analyzeImportedInterview, approvePlaybookPatch,
  revertPlaybookPatch,
} from "./corpus";

export type { CorpusLlmAnalysis } from "./corpus";

export {
  generatePodcastEpisode,
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
  InterviewGuide,
  InterviewGuideOptions,
  InterviewMode,
  InterviewResumeCard,
  InterviewSession,
  InterviewStrategyDecision,
  InterviewStrategyId,
  InterviewStrength,
  InterviewTurn,
  ImportSource,
  MemoryCandidate,
  MemoryGraphReference,
  MemoryRecord,
  MonthlyReview,
  PlaybookPatch,
  PodcastEpisode,
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
      // M1: 记忆图谱边数 = 各确认记忆内嵌的 relatedThemeIds 之和(替代退役的 contextPack.memoryEdges)。
      memoryEdgeCount: contextPack.memoryRecords.reduce((sum, record) => sum + (record.relatedThemeIds?.length ?? 0), 0),
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
        searchBriefId: importSource.searchBriefId ?? "",
        sourceUrlConfigured: Boolean(importSource.sourceUrl),
        sensitivity: importSource.sensitivity,
      };

      return {
        outputSummary:
          `ImportIngestion 已同步：${importSource.title}，${metadata.chunkCount} 个 RAG 分块` +
          (importSource.searchBriefId ? `，资料包 ${importSource.searchBriefId} 可带入专访` : "") + "。",
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
  relatedThemeIds?: string[];
}

export function createInitialProductState(): ProductState {
  return JSON.parse(JSON.stringify(initialProductState)) as ProductState;
}

/**
 * A clean-start state: same systemConfig + profile identity scaffolding as the demo,
 * but with every user-generated asset array empty and the demo-derived profile
 * memories cleared. Used by reset ("清空示例，开始我的真实记录"). Demo remains the
 * default first-run state; this is the explicit opt-out of the showcase data.
 */
export function createEmptyProductState(): ProductState {
  const base = createInitialProductState();
  return {
    ...base,
    sessions: [], notes: [], points: [], questions: [], decisions: [], debts: [], themes: [],
    memoryCorrections: [], memoryRecords: [], memoryCandidates: [],
    searchBriefs: [], podcastEpisodes: [], corpusImports: [], corpusInsights: [], playbookPatches: [],
    importSources: [], ragChunks: [],
    configVersions: [], auditEvents: [], aiRunEvents: [], workflowRuns: [], operationalChecks: [],
    profile: { ...base.profile },
    profileSuggestions: [],
    interviewAnnotations: [],
    chatSessions: [],
    revision: 0
  };
}

// ============================================================================
// Section C: External-material sanitization — consolidated into ./utils
// (single source of truth; re-exported above).
// ============================================================================

// ============================================================================
// Section D: Search-brief text helpers
// ============================================================================

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

// 审计修复(P3-42):resolveSearchBriefThemeIds(硬挂 themes[0] 的旧版)已删——search-brief.ts
// 有诚实留空的局部版在用,此处零调用的 barrel 导出是误用地雷。


// ============================================================================
// Section E & F: Interview-quality + quality-operations reports
// — Moved to ./quality-report to break the engine <-> strategy circular dep.
//   Re-exported here so all existing `import { ... } from "./engine"` sites
//   continue to work without any change.
// ============================================================================

export {
  buildInterviewQualityReport,
  buildQualityOperationsReport,
} from "./quality-report";

// ============================================================================
// Section G: Interview-transparency report
// ============================================================================

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
    observations,
  };
}

export function removeVersionSuffix(version: string, suffix: string) {
  return version.split(suffix).join("");
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

export {
  buildBootContextPack,
  retrievePersonalKnowledge,
  decideRecallAcceptance,
  decideGroundingMode,
  toCitationEnvelopes,
  noReliableMemoryNotice
} from "./retrieval";
export {
  applyImportanceDecay,
  detectMemoryContradictions,
  enrichStateAfterDedupe,
  filterEchoChamberTexts,
  resolveMemoryConflict,
  buildConsolidationQueuePreview,
  findConflictPairRecords
} from "./memory-consolidation";
export {
  buildInterruptedStash,
  formatInterruptedStashForPrompt
} from "./voice-interrupt-stash";
