export type InterviewMode =
  | "daily"
  | "decision"
  | "point"
  | "learning"
  | "organization"
  | "long-term";

export type InterviewStrength = "gentle" | "standard" | "sharp";

export type InterviewControlAction = "skip" | "softer" | "sharper" | "different-angle" | "summary" | "do-not-save";

export type SearchProviderId = "local-demo" | "bailian" | "anysearch" | "tavily" | "exa" | "brave";

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
    realtimeEnabled: boolean;
    realtimeMode: "s2s" | "livekit";
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

export type AssetStatus =
  | "临时想法"
  | "稳定观点"
  | "被挑战中"
  | "已修正"
  | "已放弃"
  | "开放"
  | "反复出现"
  | "正在聚焦"
  | "阶段性回答"
  | "待了解"
  | "能复述"
  | "已应用"
  | "不相关";

export interface UserProfile {
  name: string;
  role: string;
  industry: string;
  currentFocus: string;
  longTermGoal: string;
  preferredStrength: InterviewStrength;
  explicitBoundaries: string[];
  confirmedMemories: string[];
  inferredMemories: string[];
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

export type InterviewFollowUpSourceType = "question" | "knowledge_debt" | "theme" | "decision_review";

export interface InterviewFollowUpItem {
  id: string;
  sourceType: InterviewFollowUpSourceType;
  sourceId: string;
  title: string;
  prompt: string;
  reason: string;
  priority: number;
  mode: InterviewMode;
  updatedAt: string;
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
  | "counterexample_probe"
  | "learning_reflection"
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
    | "privacy_data_purged";
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
    | "privacy_operation";
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
  providerId: "local-workflow-runtime" | "mastra-runtime";
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
  status: "proposed" | "applied" | "reverted" | "rejected";
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
  status: "draft" | "active" | "completed";
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
  status: AssetStatus;
  confidence: "用户确认" | "AI 推断" | "待验证";
  evidence: string[];
  relatedThemeIds: string[];
  important: boolean;
  updatedAt: string;
}

export interface QuestionAsset {
  id: string;
  question: string;
  whyImportant: string;
  status: AssetStatus;
  appearances: number;
  relatedThemeIds: string[];
  nextPrompt: string;
  important: boolean;
  updatedAt: string;
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
}

export interface KnowledgeDebt {
  id: string;
  concept: string;
  context: string;
  whyImportant: string;
  status: AssetStatus;
  nextQuestion: string;
  updatedAt: string;
}

export interface ReadingAsset {
  id: string;
  title: string;
  url: string;
  publisher: string;
  summary: string;
  whyRead: string;
  status: Extract<AssetStatus, "待了解" | "已应用" | "不相关">;
  usage: "延伸阅读";
  relatedThemeIds: string[];
  important: boolean;
  createdAt: string;
  updatedAt: string;
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
}

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
  readings: ReadingAsset[];
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
  | "search_brief"
  | "manual_correction";
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
}

export type MemoryGraphTargetType =
  | "long_term_theme"
  | "question"
  | "knowledge_debt"
  | "point"
  | "decision"
  | "memory_record";

export type MemoryGraphRelation = "relates_to" | "revisits" | "raises_debt" | "supports" | "contrasts_with";

export interface MemoryEdge {
  id: string;
  fromMemoryRecordId: string;
  targetType: MemoryGraphTargetType;
  targetId: string;
  relation: MemoryGraphRelation;
  label: string;
  evidenceQuote: string;
  weight: number;
  createdAt: string;
}

export interface MemoryGraphReference {
  edgeId: string;
  memoryRecordId: string;
  targetType: MemoryGraphTargetType;
  targetId: string;
  targetLabel: string;
  relation: MemoryGraphRelation;
  reason: string;
  weight: number;
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
  searchBriefId: string;
  chunkIds: string[];
  createdAt: string;
  updatedAt: string;
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
}

export interface PodcastChapter {
  title: string;
  startsAtSec: number;
  summary: string;
}

export type PodcastSourceType = "note" | "search-brief" | "theme" | "knowledge-debt" | "corpus-insight";
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
  sourceUrl: string;
  languageHint?: string;
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
  status: "proposed" | "applied" | "reverted" | "rejected";
  rules: string[];
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
  providers: ProviderConfig[];
  observations: string[];
}

export interface ProductState {
  profile: UserProfile;
  sessions: InterviewSession[];
  notes: DualTrackNote[];
  points: PointAsset[];
  questions: QuestionAsset[];
  decisions: DecisionAsset[];
  debts: KnowledgeDebt[];
  readings: ReadingAsset[];
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
}

export interface FinalizeResult {
  note: DualTrackNote;
  nextState: ProductState;
}
