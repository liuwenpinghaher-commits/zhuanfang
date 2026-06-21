export type InterviewMode =
  | "daily"
  | "decision"
  | "point"
  | "learning"
  | "organization"
  | "long-term";

export type InterviewStrength = "gentle" | "standard" | "sharp";

export type InterviewControlAction = "skip" | "softer" | "sharper" | "different-angle" | "summary" | "do-not-save";

export type SearchProviderId = "local-demo" | "bailian" | "anysearch";

export type ProviderKind = "search" | "llm" | "voice" | "storage";

export interface ProviderConfig {
  id: string;
  kind: ProviderKind;
  label: string;
  status: "ready" | "needs-key" | "disabled" | "degraded";
  active: boolean;
  description: string;
  lastCheckedAt: string;
}

export interface SystemConfig {
  version: string;
  providers: ProviderConfig[];
  search: {
    activeProvider: SearchProviderId;
    recencyDays: number;
    maxSources: number;
    allowWebInInterview: boolean;
  };
  voice: {
    ttsProvider: "local-demo" | "bailian" | "openai" | "elevenlabs";
    defaultVoice: string;
    podcastVoice: string;
    podcastFormat: "solo" | "host-guest";
    realtimeMode: "bailian" | "livekit" | "cascade";
  };
  models: {
    planningModel: string;
    interviewModel: string;
    synthesisModel: string;
  };
  interview: {
    playbookVersion: string;
    launchMode: "immersive";
    silenceHoldMs: number;
    maxFollowUpDepth: number;
    guidanceEnabled: boolean;
    guidanceFrequency: "low" | "medium" | "high";
    maxGuidancePerTurn: number;
    minGuidanceIntervalMs: number;
    challengeBudgetPerSession: number;
  };
  memory: {
    includeSensitiveMemoriesInContext: boolean;
    includePendingCandidatesInContext: boolean;
    externalMaterialMemoryPolicy: "review-only" | "never" | "auto-candidate";
  };
  research?: {
    /** 是否启用后台自动调研调度（默认 false；常驻服务时生效，非常驻靠手动触发 auto-run） */
    autoScheduleEnabled?: boolean;
    /** 后台调度间隔（分钟），默认 1440（24h） */
    scheduleIntervalMin?: number;
  };
}

export interface ConfigVersion {
  id: string;
  version: string;
  createdAt: string;
  changedBy: "user" | "system";
  reason: string;
  diff: string[];
  active: boolean;
  rollbackTarget?: string;
  affectedSessions: string[];
  snapshot: SystemConfig;
}

// Each asset type draws from a disjoint subset of statuses. Naming the subsets lets
// the asset interfaces below carry the precise status set, so the compiler rejects
// assigning a question status to a point, etc. AssetStatus stays as the full union
// for the few places that handle assets generically (e.g. search).
export type PointStatus = "临时想法" | "稳定观点" | "被挑战中" | "已修正" | "已放弃";
export type QuestionStatus = "开放" | "反复出现" | "正在聚焦" | "阶段性回答";
export type DebtStatus = "待了解" | "能复述" | "已应用" | "不相关";

export type AssetStatus = PointStatus | QuestionStatus | DebtStatus;

export interface UserProfile {
  name: string;
  role: string;
  industry: string;
  currentFocus: string;
  longTermGoal: string;
  preferredStrength: InterviewStrength;
  explicitBoundaries: string[];
}

export interface EvidenceAnchor {
  sessionId: string;
  turnId: string;
}

export interface InterviewAnnotation {
  id: string;
  sessionId: string;
  turnId: string;
  text: string;
  createdAt: string;
}

export interface InterviewRawMaterial {
  sessionId: string;
  turns: InterviewTurn[];
  strategyTrace: InterviewStrategyDecision[];
  createdAt: string;
}

/** 录音归属的说话方：受访者(默认) / 主持人。 */
export type InterviewAudioRole = "interviewee" | "interviewer";

export interface InterviewAudio {
  sessionId: string;
  /** 录音归属说话方；缺省语义为 "interviewee"（向后兼容旧的隐含受访者单路存储）。 */
  role: InterviewAudioRole;
  audio: Uint8Array;
  mime: string;
  byteSize: number;
  durationMs?: number;
  /** 录音起始的墙钟 ISO 时间，使前端能按 `turn.timestamp - recordingStartedAt` 算出每轮在整段录音里的偏移。 */
  recordingStartedAt?: string;
  createdAt: string;
}

export type KnowledgeSourceType =
  | "note" | "memory" | "theme" | "point" | "decision" | "debt" | "transcript" | "material";

export interface KnowledgeChunk {
  id: string;
  sourceType: KnowledgeSourceType;
  sourceId: string;
  title: string;
  text: string;
  keywords: string[];
  embedding?: number[];
  createdAt: string;
}

export interface ChatCitation { sourceType: KnowledgeSourceType; sourceId: string; title: string; snippet: string; }
export interface ChatMessage { id: string; role: "user" | "assistant"; content: string; citations?: ChatCitation[]; createdAt: string; }
export interface ChatSession { id: string; title: string; messages: ChatMessage[]; createdAt: string; updatedAt: string; }

export type ProfileSuggestionStatus = "pending" | "approved" | "rejected";
/** Only the two profile fields that actually shape interviews and can plausibly evolve over time. */
export type ProfileSuggestionField = "currentFocus" | "longTermGoal";

/**
 * A finalize-time proposal that the user's currentFocus / longTermGoal has shifted, surfaced for
 * human-in-the-loop approval (mirrors MemoryCandidate). Approving applies `suggestedValue` to the
 * profile; the profile is never silently overwritten by inference.
 */
export interface ProfileSuggestion {
  id: string;
  field: ProfileSuggestionField;
  currentValue: string;
  suggestedValue: string;
  reason: string;
  evidenceQuote: string;
  sourceSessionId: string;
  status: ProfileSuggestionStatus;
  createdAt: string;
  reviewedAt?: string;
}

export interface InterviewCard {
  title: string;
  whyNow: string;
  suggestedOpening: string;
  historyReferences: string[];
  potentialTension: string;
  suggestedPerspectives: string[];
  likelyOutputs: string[];
  searchBriefId?: string;
  sourceHighlights?: SourceHighlight[];
}

export interface InterviewResumeCard {
  sessionId: string;
  title: string;
  mode: InterviewMode;
  currentTopic: string;
  startedAt: string;
  lastUpdatedAt: string;
  lastUserQuote: string;
  pendingQuestion: string;
  nextClue: string;
  alreadyClarified: string[];
  turnCount: number;
}

export interface InterviewGuide {
  topicHint: string;
  dailyBrief: {
    suggestedTopic: string;
    openingQuestion: string;
    contextNote: string;
  };
  perspectiveCoverage: Record<string, number>;
  missingPerspectives: string[];
  recommendedPerspectives: string[];
  perspectiveRationale: string;
  relevantMemories: string[];
  graphReferences: MemoryGraphReference[];
  opinionEvolution: Array<{
    topic: string;
    oldView: string;
    newView: string;
    date: string;
  }>;
  statedPositions: string[];
  openDebts: Array<{
    concept: string;
    context: string;
    daysOpen: number;
    nextQuestion: string;
  }>;
  debtToAddress?: string;
  blindspotCandidates: Array<{
    concept: string;
    importance: "low" | "medium" | "high";
    reason: string;
  }>;
  knowledgeFragments: string[];
  suggestedOpening: string;
  strategyChecklist: string[];
}

export interface InterviewGuideOptions {
  topicHint?: string;
  searchBriefId?: string;
  /** M3c: route-computed query vector; when present, memory recall uses cosine instead of substring. */
  queryEmbedding?: number[];
}

export interface InterviewTurn {
  id: string;
  role: "user" | "assistant";
  content: string;
  intent: string;
  timestamp: string;
  referencedMemory?: string;
  strategy?: InterviewStrategyId;
  depth?: InterviewDepth;
  truncated?: InterviewTurnTruncation;
  providerTurnId?: string;
  /**
   * Speaking manner distilled from the character model's （…）stage-direction asides. The asides
   * are stripped out of `content` (so the transcript reads as clean words like a real interview)
   * and kept here so the voice path can still deliver the question with the intended emotion.
   */
  prosody?: { rate: number; pitch: number; volume: number };
}

export interface InterviewTurnTruncation {
  spokenChars: number;
  originalChars: number;
  reason: "user_interrupt" | "provider_error";
  truncatedAt: string;
}

export type InterviewStrategyId =
  | "mechanism_probe"
  | "concrete_example_probe"
  | "mechanism_reversal_probe"
  | "debt_followup"
  | "perspective_shift"
  | "blindspot_probe"
  | "premise_challenge"
  | "synthesis";

export type InterviewDepth = "surface" | "mechanism" | "meta" | "synthesis";

export interface InterviewStrategyDecision {
  strategy: InterviewStrategyId;
  label: string;
  reason: string;
  depth: InterviewDepth;
  turnIndex: number;
  perspective?: string;
  blindspotConcept?: string;
  referencedMemory?: string;
}

export interface InterviewQualityGate {
  id:
    | "perspective_coverage"
    | "debt_followup"
    | "blindspot_probe"
    | "history_reference_rate"
    | "meta_depth"
    | "forbidden_terms"
    | "realtime_turn_taking";
  label: string;
  passed: boolean;
  target: string;
  actual: string;
  detail: string;
}

export interface InterviewQualityReport {
  score: number;
  gates: InterviewQualityGate[];
  perspectivesUsed: string[];
  depthsReached: InterviewDepth[];
  forbiddenTerms: string[];
  historyReferenceRate: number;
  generatedAt: string;
}

export type AuditEventSeverity = "info" | "warning" | "critical";

export interface AuditEvent {
  id: string;
  type:
    | "interview_session_finalized"
    | "memory_correction_created"
    | "memory_referenced"
    | "memory_candidate_updated"
    | "memory_candidate_approved"
    | "memory_candidate_rejected"
    | "memory_record_updated"
    | "memory_record_deprecated"
    | "memory_record_deleted"
    | "playbook_patch_applied"
    | "playbook_patch_reverted"
    | "system_config_changed"
    | "system_config_reverted"
    | "search_brief_created"
    | "search_brief_asset_created"
    | "podcast_episode_created"
    | "reference_material_imported"
    | "corpus_import_analyzed"
    | "interview_feedback_submitted"
    | "context_security_intercepted"
    | "decision_candidate_confirmed"
    | "privacy_data_purged"
    | "state_imported"
    | "profile_updated"
    | "profile_suggestion_created"
    | "profile_suggestion_approved"
    | "profile_suggestion_rejected"
    | "cascade_decision_logged"
    | "annotation_created"
    | "annotation_removed"
    | "chat_session_created"
    | "knowledge_index_rebuilt";
  label: string;
  detail: string;
  severity: AuditEventSeverity;
  entityType:
    | "interview_session"
    | "memory"
    | "memory_candidate"
    | "memory_record"
    | "playbook_patch"
    | "system_config_version"
    | "search_brief"
    | "import_source"
    | "podcast_episode"
    | "corpus_import"
    | "dual_track_note"
    | "decision"
    | "privacy_operation"
    | "user_profile"
    | "chat_session"
    | "knowledge_index";
  entityId: string;
  createdAt: string;
}

export interface AiRunEvent {
  id: string;
  workflow:
    | "interview_quality_scoring"
    | "interview_turn_generation"
    | "interview_preparation"
    | "context_pack_build"
    | "memory_projection"
    | "import_ingestion"
    | "search_brief_generation"
    | "podcast_generation"
    | "reference_interview_learning";
  workflowRunId?: string;
  providerId: string;
  status: "succeeded" | "degraded" | "failed";
  entityType: "interview_session" | "search_brief" | "import_source" | "podcast_episode" | "corpus_import";
  entityId: string;
  inputSummary: string;
  outputSummary: string;
  latencyMs?: number;
  estimatedTokens?: number;
  degradedReason?: string;
  metrics?: AiRunEventMetrics;
  createdAt: string;
}

export interface AiRunEventMetrics {
  timeToFirstTokenMs?: number;
  timeToFirstAudioMs?: number;
  endOfUtteranceDelayMs?: number;
  turnDetectorConfidence?: number;
  turnDetectorId?: string;
  interruptedAtMs?: number;
  spokenCharsBeforeInterrupt?: number;
}

export type WorkflowId =
  | "interview_preparation"
  | "context_pack_build"
  | "memory_projection"
  | "import_ingestion"
  | "search_brief_generation"
  | "podcast_generation"
  | "reference_interview_learning";

export interface WorkflowRun {
  id: string;
  workflow: WorkflowId;
  status: "queued" | "running" | "succeeded" | "degraded" | "failed";
  providerId: "local-workflow-runtime";
  entityType: AiRunEvent["entityType"];
  entityId: string;
  inputSummary: string;
  outputSummary: string;
  startedAt: string;
  completedAt?: string;
  latencyMs?: number;
  traceId: string;
  degradedReason?: string;
  metadata?: Record<string, string | number | boolean>;
}

export type OperationalCheckKind = "provider-smoke" | "workflow-runtime-smoke";
export type OperationalCheckStatus = "passed" | "failed" | "skipped";

export interface OperationalCheckEvidence {
  id: string;
  kind: OperationalCheckKind;
  label: string;
  status: OperationalCheckStatus;
  summary: {
    passed: number;
    failed: number;
    skipped: number;
  };
  detail: string;
  requiredEnv: string[];
  checkedAt: string;
  generatedAt: string;
  metadata?: Record<string, string | number | boolean>;
}

export interface TriggerWorkflowRunInput {
  workflow: WorkflowId;
  entityType: AiRunEvent["entityType"];
  entityId: string;
  inputSummary: string;
}

export interface QualityOperationsMetric {
  id:
    | "interview_naturalness"
    | "followup_relevance"
    | "memory_citation"
    | "memory_candidate_precision"
    | "context_pack_relevance"
    | "sensitive_leakage"
    | "source_faithfulness";
  label: string;
  score: number;
  target: string;
  status: "pass" | "watch" | "risk";
  detail: string;
}

export interface PlaybookQualityComparison {
  playbookVersion: string;
  sessionCount: number;
  averageQualityScore: number;
  averageMemoryCitationRate: number;
  deltaFromBaseline: number;
  recommendation: "promote" | "watch" | "rollback";
}

export interface QualityRemediationAction {
  id: string;
  sourceMetricId?: QualityOperationsMetric["id"];
  priority: "high" | "medium" | "low";
  owner: "interview_director" | "memory_review" | "provider_ops" | "user_review";
  title: string;
  action: string;
  evidence: string;
  nextInterviewInstruction: string;
}

export interface QualityOperationsReport {
  generatedAt: string;
  overallScore: number;
  metrics: QualityOperationsMetric[];
  playbookComparisons: PlaybookQualityComparison[];
  recentAuditEvents: AuditEvent[];
  recentAiRunEvents: AiRunEvent[];
  risks: string[];
  remediationActions: QualityRemediationAction[];
}

export interface InterviewTransparencyItem {
  sessionId: string;
  title: string;
  status: InterviewSession["status"];
  startedAt: string;
  searchSources: SourceHighlight[];
  agendaReferences: Array<{
    topic: string;
    agendaItemId: string;
    source: string;
    intent: SearchAgendaIntent;
    reason: string;
    seedAssetIds: string[];
  }>;
  memoryReferences: string[];
  playbookReferences: InterviewPlaybookReference[];
  playbookVersion: string;
  interviewModel: string;
  strategyReasons: string[];
  controls: string[];
  realtimeSignals: string[];
  degradedEvents: Array<{
    workflow: AiRunEvent["workflow"];
    providerId: string;
    reason: string;
  }>;
}

export interface InterviewPlaybookReference {
  patchId: string;
  title: string;
  status: "proposed" | "applied" | "reverted";
  impact: "low" | "medium" | "high";
  sourceInsightId: string;
  sourceImportId?: string;
  sourceTitle?: string;
  sourceUrl?: string;
  rules: string[];
}

export interface InterviewEnginePolicy {
  allowWebInInterview: boolean;
  maxFollowUpDepth: number;
  silenceHoldMs: number;
  playbookVersion: string;
  appliedPlaybookRules: string[];
  /**
   * Distinct ruleTypes aggregated from the applied playbook patches. Lets the
   * strategy engine route by classification instead of keyword-matching rule
   * text. Optional for backward compatibility with sessions/policies built
   * before ruleType existed.
   */
  appliedPlaybookRuleTypes?: string[];
  qualityGuardrails: string[];
  memory: SystemConfig["memory"];
  guidanceEnabled: boolean;
  guidanceFrequency: "low" | "medium" | "high";
  maxGuidancePerTurn: number;
  minGuidanceIntervalMs: number;
  challengeBudgetPerSession: number;
}

export interface InterviewSession {
  id: string;
  mode: InterviewMode;
  strength: InterviewStrength;
  status: "active" | "completed";
  title: string;
  card: InterviewCard;
  guide: InterviewGuide;
  turns: InterviewTurn[];
  strategyTrace?: InterviewStrategyDecision[];
  qualityReport?: InterviewQualityReport;
  enginePolicy?: InterviewEnginePolicy;
  realtimeSignals?: RealtimeSessionSignal[];
  startedAt: string;
  completedAt?: string;
  askedAnchor?: string;
  doNotSave?: boolean;
  /**
   * The control action the user just applied, consumed by the NEXT turn's prompt as an
   * explicit directive then cleared. Replaces fragile substring-matching of the control
   * feedback话术 (findPendingControlAction) for the live LLM path.
   */
  pendingControl?: InterviewControlAction;
  interactionPreSignals?: InteractionPreSignals;
  /** v2 软标签：本会话软归属的主题线（可多归属、可为空）。 */
  relatedThemeIds?: string[];
  rawMaterialOffloaded?: boolean;
}

export interface InterviewAgentContext {
  instructions: string;
  sessionTitle: string;
  turnCount: number;
  latestUserTurn: string | null;
  history: Array<{ role: "user" | "assistant"; text: string }>;
}

export type ExpressionState =
  | "fluent"
  | "organizing"
  | "hesitating"
  | "circling"
  | "emotional"
  | "concluding";

export interface DepthDirection {
  concept: string;
  reason: string;
  guidance: string;
}

export interface InteractionPreSignals {
  depthDirection: DepthDirection | null;
  backchannelWhitelist: string[];
  interruptTriggers: string[];
  interruptSensitivity: "low" | "medium" | "high";
}

export type InteractionIntent = "backchannel" | "guidance" | "interruption" | "noise";

export interface IntentDecision {
  intent: InteractionIntent;
  confidence: number;
  action: "continue" | "nudge" | "stop" | "ignore";
  detail?: {
    kind?: GuidanceKind;
    text?: string;
    anchor?: string;
  };
}

export interface DualTrackNote {
  id: string;
  sessionId: string;
  title: string;
  summary: string;
  keyQuote: string;
  saidTrack: string[];
  learnedTrack: string[];
  nextQuestions: string[];
  createdAt: string;
  feedback?: InterviewFeedback;
  relatedThemeIds?: string[];
  keyQuoteAnchor?: EvidenceAnchor;
}

export type InterviewFeedbackTag =
  | "went-deep"
  | "off-track"
  | "too-gentle"
  | "too-strong"
  | "memory-wrong"
  | "summary-accurate"
  | "continue-next";

export interface InterviewFeedbackInput {
  tags: InterviewFeedbackTag[];
  mostValuableQuestion?: string;
  inaccurateSummary?: string;
  uncomfortableButImportant?: string;
  newUnderstanding?: string;
  continuePrompt?: string;
}

export interface InterviewFeedback extends InterviewFeedbackInput {
  id: string;
  noteId: string;
  sessionId: string;
  createdAt: string;
}

export interface PointAsset {
  id: string;
  title: string;
  content: string;
  status: PointStatus;
  confidence: "用户确认" | "AI 推断" | "待验证";
  evidence: string[];
  relatedThemeIds: string[];
  important: boolean;
  updatedAt: string;
  /** 产出该资产的专访会话 id */
  sourceSessionId?: string;
  evidenceAnchors?: EvidenceAnchor[];
}

export interface QuestionAsset {
  id: string;
  question: string;
  whyImportant: string;
  status: QuestionStatus;
  appearances: number;
  relatedThemeIds: string[];
  nextPrompt: string;
  important: boolean;
  updatedAt: string;
  /** 产出该资产的专访会话 id */
  sourceSessionId?: string;
}

export interface DecisionAsset {
  id: string;
  title: string;
  decisionKind: "候选决策" | "用户决策";
  confirmationStatus: "待用户确认" | "用户确认";
  choice: string;
  tradeOff: string;
  riskHypothesis: string;
  reviewAt: string;
  status: "待复盘" | "已复盘";
  updatedAt: string;
  relatedThemeIds?: string[];
  /** 产出该资产的专访会话 id */
  sourceSessionId?: string;
  evidenceAnchors?: EvidenceAnchor[];
}

export interface KnowledgeDebt {
  id: string;
  concept: string;
  context: string;
  whyImportant: string;
  status: DebtStatus;
  nextQuestion: string;
  updatedAt: string;
  relatedThemeIds?: string[];
  /** 产出该资产的专访会话 id */
  sourceSessionId?: string;
  evidenceAnchors?: EvidenceAnchor[];
}


export interface LongTermTheme {
  id: string;
  name: string;
  summary: string;
  maturity: "萌芽" | "重复" | "聚焦" | "成型" | "变化" | "关闭";
  representativeQuote: string;
  appearances: number;
  nextQuestion: string;
  updatedAt: string;
  // ── v2 Track 升级字段（可选以兼容 v1 数据；迁移函数补默认值）──
  createdAt?: string;
  /** representativeQuote 逐字摘录回匹配到的用户原话锚点；匹配不到则缺省——绝不伪造来源。 */
  representativeQuoteAnchor?: EvidenceAnchor;
}

/** Track 是 LongTermTheme 升级后的对外概念名（软聚合主题线）。
 *  存储字段名保持 `themes` 不变，避免 21 处 `.themes` 引用的机械改名。 */
export type Track = LongTermTheme;

export interface MonthlyReview {
  topTheme: string;
  changedView: string;
  avoidedQuestion: string;
  recommendedNextInterview: string;
  metrics: {
    notes: number;
    points: number;
    questions: number;
    knowledgeDebts: number;
    themes: number;
  };
}

export interface SearchResult {
  query: string;
  total: number;
  notes: DualTrackNote[];
  points: PointAsset[];
  questions: QuestionAsset[];
  decisions: DecisionAsset[];
  debts: KnowledgeDebt[];
  themes: LongTermTheme[];
}

export interface RadarMetric {
  label: string;
  value: number;
  max: number;
}

export interface CognitiveRadar {
  depth: RadarMetric[];
  perspectives: RadarMetric[];
  assets: RadarMetric[];
  statuses: RadarMetric[];
}

export interface YearlyReview {
  coreQuestions: string[];
  changedViews: string[];
  unresolvedPatterns: string[];
  importantDecisions: string[];
  missingPerspectives: string[];
  nextYearFocus: string;
}

export interface MemoryCorrection {
  id: string;
  text: string;
  createdAt: string;
}

export type MemorySourceType =
  | "profile"
  | "interview_session"
  | "dual_track_note"
  | "corpus_import"
  | "import_source"
  | "search_brief";
export type MemoryRecordStatus = "confirmed" | "deprecated" | "deleted";
export type MemoryCandidateStatus = "pending" | "approved" | "rejected";
export type MemorySensitivity = "normal" | "sensitive";

export interface MemoryRecord {
  id: string;
  text: string;
  status: MemoryRecordStatus;
  sourceType: MemorySourceType;
  sourceId: string;
  evidenceQuote: string;
  sourceCandidateId?: string;
  sensitivity?: MemorySensitivity;
  createdAt: string;
  updatedAt: string;
  deprecatedReason?: string;
  /** M3: 语义检索向量，由嵌入模型生成；缺省时退化为关键词检索 */
  embedding?: number[];
  /** M3: 显著性评分 1–10，消费侧缺省按 5 处理 */
  importance?: number;
  /** M3: 最近访问/确认时间，用于检索 recency 衰减。当前在确认(approve)时写入；
   *  按每次召回回写为后续增强（domain 纯函数不持时钟，回写需在路由层做）。 */
  lastAccessedAt?: string;
  evidenceAnchors?: EvidenceAnchor[];
}

export interface MemoryCandidate {
  id: string;
  text: string;
  status: MemoryCandidateStatus;
  sourceType: MemorySourceType;
  sourceId: string;
  evidenceQuote: string;
  reason: string;
  sensitivity: MemorySensitivity;
  reviewScore: number;
  reviewSignals: string[];
  createdAt: string;
  reviewedAt?: string;
  reviewNote?: string;
  /** M3: 去重提示 — 指向与此候选高度相似的已有 MemoryRecord id（Task 6 去重用） */
  similarToRecordId?: string;
  /** M3: 去重操作建议 */
  suggestedUpdate?: "add" | "update" | "noop" | "conflict";
  /**
   * M5: suggested importance carried from a consolidation source (the merged cluster's
   * keeper), so approving the summary doesn't dilute显著性 back down to a reviewScore band.
   */
  importance?: number;
  evidenceAnchors?: EvidenceAnchor[];
}

export interface MemoryEdge {
  id?: string;
  fromMemoryRecordId: string;
  themeId: string;
  createdAt?: string;
}

export interface MemoryGraphReference {
  themeId: string;
  themeLabel: string;
}

export interface ContextSecurityInterception {
  kind:
    | "sensitive_memory_excluded"
    | "sensitive_candidate_excluded"
    | "unsafe_memory_status_excluded"
    | "external_instruction_removed";
  sourceType: "memory_record" | "memory_candidate" | "search_brief" | "rag_chunk";
  sourceId: string;
  label: string;
  reason: string;
  severity: AuditEventSeverity;
}

export interface InterviewContextPack {
  topicHint: string;
  confirmedMemories: string[];
  memoryRecords: MemoryRecord[];
  pendingCandidates: MemoryCandidate[];
  corrections: MemoryCorrection[];
  memoryEdges: MemoryEdge[];
  graphReferences: MemoryGraphReference[];
  searchBriefs: SearchBrief[];
  sourceHighlights: SourceHighlight[];
  ragChunks: RagChunk[];
  securityInterceptions: ContextSecurityInterception[];
  sources: Array<{
    id: string;
    type: MemorySourceType;
    label: string;
  }>;
}

export interface SourceHighlight {
  id: string;
  title: string;
  url: string;
  publisher: string;
  publishedAt: string;
  snippet: string;
  relevanceScore: number;
  usage: "topic-suggestion" | "interview-context" | "post-note-reference";
}

export type SearchAgendaIntent = "hotspot" | "knowledge-refresh" | "counterpoint" | "memory-cross-check";

export interface SearchAgendaItem {
  id: string;
  query: string;
  source: string;
  reason: string;
  intent: SearchAgendaIntent;
  seedAssetIds: string[];
}

export interface SearchBriefInput {
  topic: string;
  provider: SearchProviderId;
  status: "ready" | "needs-review";
  summary: string;
  facts: string[];
  controversies: string[];
  opposingViews: string[];
  interviewAngles: string[];
  discussionTopics: string[];
  sourceAngles: string[];
  sources: SourceHighlight[];
  sourceTrace?: SearchBriefSourceTrace[];
  agendaTrace?: SearchBriefAgendaTrace;
}

export interface SearchBrief extends SearchBriefInput {
  id: string;
  sourceTrace: SearchBriefSourceTrace[];
  appliedToSessionIds: string[];
  createdAt: string;
  /** 持续追踪，可重新调研刷新 */
  tracked?: boolean;
  /** 最近一次刷新的时间；新鲜度计算优先使用此字段，为空时回退到 createdAt */
  lastRefreshedAt?: string;
}

export type SearchBriefClaimType =
  | "fact"
  | "controversy"
  | "opposing-view"
  | "interview-angle"
  | "discussion-topic"
  | "source-angle";

export interface SearchBriefSourceTrace {
  id: string;
  claimType: SearchBriefClaimType;
  claim: string;
  sourceIds: string[];
  sourceLabels: string[];
}

export interface SearchBriefAgendaTrace {
  agendaItemId: string;
  source: string;
  reason: string;
  intent: SearchAgendaIntent;
  seedAssetIds: string[];
}

export interface ReferenceMaterialImportInput {
  title: string;
  sourceType: "text" | "webpage";
  content: string;
  sourceUrl?: string;
  sensitivity?: MemorySensitivity;
}

export interface ImportSource {
  id: string;
  title: string;
  sourceType: ReferenceMaterialImportInput["sourceType"];
  sourceUrl?: string;
  content: string;
  status: "chunked";
  sensitivity: MemorySensitivity;
  searchBriefId?: string;
  chunkIds: string[];
  createdAt: string;
  updatedAt: string;
  /** v2 软标签：软归属的主题线（与 points/notes 等一致的模式） */
  relatedThemeIds?: string[];
}

export interface RagChunk {
  id: string;
  sourceId: string;
  title: string;
  text: string;
  keywords: string[];
  tokenEstimate: number;
  sourceUrl?: string;
  usage: "interview-context" | "memory-candidate";
  createdAt: string;
  /** 语义检索向量，由嵌入模型生成；缺省时退化为关键词检索 */
  embedding?: number[];
}

export interface PodcastChapter {
  title: string;
  startsAtSec: number;
  summary: string;
}

export type PodcastSourceType = "note" | "search-brief" | "theme" | "knowledge-debt";
export type PodcastAudioRenderStatus = "pending" | "rendered" | "fallback";

export interface PodcastEpisode {
  id: string;
  noteId: string;
  sourceType?: PodcastSourceType;
  sourceId?: string;
  sourceLabel?: string;
  title: string;
  format: "solo" | "host-guest";
  voice: string;
  status: "draft" | "generating" | "ready";
  scriptReviewStatus: "待确认" | "用户确认";
  durationSec: number;
  script: string;
  aiDisclosure?: string;
  chapters: PodcastChapter[];
  audioUrl: string;
  audioExpiresAt?: string;
  audioRenderStatus?: PodcastAudioRenderStatus;
  audioRenderMessage?: string;
  shownotes: string[];
  createdAt: string;
}

export interface CorpusImportInput {
  title: string;
  mediaType: "text" | "audio";
  content: string;
  sourceUrl?: string;
}

export interface AudioTranscriptionInput {
  title: string;
  /**
   * Public audio URL (http/https/oss). Required for real SenseVoice transcription,
   * which only accepts `file_urls`. Empty when the user uploads a local file instead.
   */
  sourceUrl: string;
  languageHint?: string;
  /**
   * Base64 payload of a locally selected audio file (no data-uri prefix). There is
   * no inline transcription path on the backend (SenseVoice needs a public URL and
   * the only base64 audio capability is the streaming realtime ASR pipeline), so a
   * local file is acknowledged and honestly degraded — never faked into a transcript.
   */
  audioBase64?: string;
  /** Original file name of the uploaded local file, surfaced in the degraded notice. */
  fileName?: string;
}

export interface AudioTranscription {
  providerId: "bailian-sensevoice" | "local-fallback";
  model: string;
  status: "ready" | "degraded";
  title: string;
  sourceUrl: string;
  text: string;
  createdAt: string;
  taskId?: string;
  transcriptionUrl?: string;
  durationSec?: number;
  degradedReason?: string;
}

export interface CorpusTurn {
  speaker: string;
  content: string;
  move: "opening" | "follow-up" | "challenge" | "reflection" | "answer";
}

export interface CorpusImport {
  id: string;
  title: string;
  mediaType: "text" | "audio";
  content: string;
  sourceUrl?: string;
  status: "analyzed";
  turns: CorpusTurn[];
  createdAt: string;
}

export interface CorpusDimension {
  name: string;
  score: number;
  finding: string;
  example: string;
  recommendedAction: string;
}

export interface CorpusImprovementPlanItem {
  title: string;
  rationale: string;
  action: string;
  expectedEngineChange: string;
  evidence: string;
}

export interface PlaybookPatch {
  id: string;
  title: string;
  description: string;
  sourceInsightId: string;
  sourceImportId?: string;
  sourceTitle?: string;
  sourceUrl?: string;
  status: "proposed" | "applied" | "reverted";
  rules: string[];
  /**
   * Optional machine-readable classification of each rule, positionally aligned
   * with `rules`. Drives strategy routing (concrete-moment / mechanism-reversal)
   * without relying on brittle keyword matching of the rule text. Legacy patches
   * predating this field fall back to keyword matching.
   */
  ruleTypes?: Array<"concrete-moment" | "mechanism-reversal" | string>;
  impact: "low" | "medium" | "high";
  createdAt: string;
  appliedAt?: string;
  revertedAt?: string;
}

export interface CorpusInsight {
  id: string;
  importId: string;
  title: string;
  dimensions: CorpusDimension[];
  improvementPlan: CorpusImprovementPlanItem[];
  recommendedPatches: PlaybookPatch[];
  createdAt: string;
}

export interface RealtimeSignal {
  inputLevel: number;
  silenceMs: number;
  isUserSpeaking: boolean;
  isAssistantSpeaking?: boolean;
}


export type GuidanceKind =
  | "nudge"
  | "echo"
  | "anchor_probe"
  | "concretize"
  | "emotion_label"
  | "contradiction"
  | "mini_summary"
  | "mirror";

export interface RealtimeGuidanceDecision {
  kind: GuidanceKind;
  text: string;
  anchor?: string;
  reason: string;
  confidence: number;
}

export interface RealtimeTurnState {
  phase: "listening" | "holding" | "thinking" | "speaking";
  nextAction: string;
  backchannel?: string;
  shouldInterrupt: boolean;
  confidence: number;
  guidance?: RealtimeGuidanceDecision;
}

export interface RealtimeSessionSignal {
  id: string;
  eventType: RealtimeSessionEventType;
  phase: RealtimeTurnState["phase"];
  transcript?: string;
  inputLevel: number;
  silenceMs: number;
  shouldInterrupt: boolean;
  backchannel?: string;
  nextAction: string;
  assistantTurnId?: string;
  assistantIntent?: string;
  createdAt: string;
  agentState?: RealtimeAgentState;
  spokenTextSoFar?: string;
  truncatedFromChars?: number;
  metrics?: RealtimeSignalMetrics;
  turnDetectorId?: string;
  detectorReason?: string;
  detectorConfidence?: number;
  guidanceKind?: GuidanceKind;
  guidanceText?: string;
  guidanceAnchor?: string;
}

export type RealtimeSessionEventType =
  | "listening"
  | "hold"
  | "interruption"
  | "assistant_response"
  | "user_started_speaking"
  | "user_stopped_speaking"
  | "user_input_transcribed"
  | "agent_state_changed"
  | "agent_speech_committed"
  | "agent_speech_interrupted"
  | "metrics_collected"
  | "guidance_triggered"
  | "guidance_delivered";

export type RealtimeAgentState = "initializing" | "listening" | "thinking" | "speaking";

export interface RealtimeSignalMetrics {
  timeToFirstTokenMs?: number;
  timeToFirstAudioMs?: number;
  turnDetectorConfidence?: number;
  interruptedAtMs?: number;
  spokenCharsBeforeInterrupt?: number;
}

export interface SystemStatus {
  configVersion: string;
  activeProviders: {
    search: SearchProviderId;
    voice: string;
    interviewModel: string;
  };
  observations: string[];
}

export interface ProductState {
  profile: UserProfile;
  profileSuggestions: ProfileSuggestion[];
  interviewAnnotations: InterviewAnnotation[];
  chatSessions: ChatSession[];
  sessions: InterviewSession[];
  notes: DualTrackNote[];
  points: PointAsset[];
  questions: QuestionAsset[];
  decisions: DecisionAsset[];
  debts: KnowledgeDebt[];
  themes: LongTermTheme[];
  memoryCorrections: MemoryCorrection[];
  memoryRecords: MemoryRecord[];
  memoryCandidates: MemoryCandidate[];
  memoryEdges: MemoryEdge[];
  searchBriefs: SearchBrief[];
  importSources: ImportSource[];
  ragChunks: RagChunk[];
  podcastEpisodes: PodcastEpisode[];
  corpusImports: CorpusImport[];
  corpusInsights: CorpusInsight[];
  playbookPatches: PlaybookPatch[];
  configVersions: ConfigVersion[];
  auditEvents: AuditEvent[];
  aiRunEvents: AiRunEvent[];
  workflowRuns: WorkflowRun[];
  operationalChecks: OperationalCheckEvidence[];
  systemConfig: SystemConfig;
  revision: number;
  /** 数据模型版本。v2 迁移后为 2；缺失视为 v1。 */
  schemaVersion?: number;
}


export interface FinalizeResult {
  note: DualTrackNote;
  nextState: ProductState;
}
