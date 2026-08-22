/** Product API types & small helpers (split from productApi.ts). */
import type { StateExportBundle } from "../domain/backup";
import type { PrivacyReport } from "../domain/privacy";
import type { CapabilityTask } from "../capabilities/task";
import type {
  AudioTranscription,
  AudioTranscriptionInput,
  ChatCitation,
  CognitiveRadar,
  CorpusImportInput,
  CorpusInsight,
  DualTrackNote,
  InteractionPreSignals,
  InterviewControlAction,
  InterviewMode,
  InterviewRawMaterial,
  InterviewSession,
  InterviewStrength,
  MonthlyReview,
  PodcastEpisode,
  ProductState,
  SearchBrief,
  SearchBriefInput,
  SearchProviderId,
  YearlyReview
} from "../domain/types";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ProductApiClient {
  exportState(): Promise<StateExportBundle>;
  /**
   * 审计修复 F-04:legacy 包(无 rawMaterials/audios 数组的裸 state)服务端要求显式
   * coldLayerMode,否则 422;完整导出包不需要。成功返回 state + 独立 receipt；执行失败
   * 抛 ApiError(500, body 含结构化 journal:failedStep/rolledBack/steps)。
   */
  importState(payload: unknown, coldLayerMode?: ColdLayerMode): Promise<StateImportResult>;
  getPrivacyReport(): Promise<PrivacyReport>;
  /** F-04:成功时附带服务端逐库清理回执;部分失败抛 ApiError(500, body 含 state+purgeReceipt)。 */
  purgeState(): Promise<ProductState & { purgeReceipt?: PurgeReceipt }>;
  reportVoiceLatency(sample: {
    path?: string;
    ttfaMs?: number;
    vadEndToSttMs?: number;
    sttToLlmMs?: number;
    llmTtftMs?: number;
    ttsTtfbMs?: number;
    interrupted?: boolean;
    /** Cascade/interrupt: barge-in stopped playback / aborted turn. */
    bargeInSuccess?: boolean;
    /** Post-interrupt next turn retained interrupted context (stash). */
    interruptRecovery?: boolean;
    /** Phase-0 false-trigger / echo-guard countable event. */
    falseTriggerKind?: "quarantine_echo_suspect" | "max_wait_suppressed" | "auto_committed_echo_suspect";
    sessionId?: string;
  }): Promise<void>;
  getSystemCapabilities(): Promise<SystemCapabilitiesResponse>;
  getSystemConfig(): Promise<SystemConfigResponse>;
  updateSystemConfig(updates: SystemConfigUpdateRequest): Promise<SystemConfigUpdateResponse>;
  getState(): Promise<ProductState>;
  /**
   * N-02:轻量健康探针(route-agnostic 落库降级数据源)。前端低频轮询该端点驱动持久顶栏 banner:
   * persist.degraded 时常驻、恢复即消失——覆盖全部"200+异步落库"写路径(资产确认/记忆编辑等从不
   * PUT /api/state 却共享同一 persistQueue)。auth 豁免、只读、不触发任何写/联网副作用。
   */
  getHealth(): Promise<HealthResponse>;
  getReviews(): Promise<ReviewsResponse>;
  importDocument(input: ImportDocumentRequest): Promise<ImportDocumentResponse>;
  /** Full rebuild of the server-side knowledge index. Returns how many chunks were indexed. */
  rebuildKnowledgeIndex(): Promise<{ chunkCount: number }>;
  /**
   * 纯导入资料 QA：仅检索 state.ragChunks（interview-context 导入块）。
   * 与 sendChatMessage（/api/chat，八源 knowledge）产品语义分离——资料库「就资料提问」专用。
   */
  queryRag(question: string): Promise<RagQueryResponse>;
  /**
   * Ask the asset-grounded chat assistant. sessionId=null starts a new session;
   * the server appends both the user message and the grounded answer, then returns
   * the full replaced state plus the (new or existing) sessionId, the answer text
   * and its citations. The caller adopts the returned state and selects sessionId.
   */
  sendChatMessage(
    sessionId: string | null,
    message: string
  ): Promise<{
    state: ProductState;
    sessionId: string;
    answer: string;
    citations: ChatCitation[];
    groundingMode?: "grounded" | "partial" | "refused";
  }>;
  confirmDecision(id: string): Promise<ProductState>;
  /** Apply a proposed PlaybookPatch (optionally with user-edited rules). Server is authoritative
   *  (CAS-guarded state machine); returns the persisted state. Throws on 404/409. */
  applyPlaybookPatch(id: string, overrideRules?: string[]): Promise<ProductState>;
  /** Revert an applied PlaybookPatch. Throws 404/422 (only applied records can be reverted). */
  revertPlaybookPatch(id: string): Promise<ProductState>;
  approveMemoryCandidate(
    id: string,
    opts?: { mode?: "merge" | "add"; force?: boolean }
  ): Promise<{
    state: ProductState;
    embeddingReady?: boolean;
    vectorRecallAvailable?: boolean;
    warning?: string;
    blocked?: boolean;
  }>;
  rejectMemoryCandidate(id: string, reviewNote?: string): Promise<ProductState>;
  consolidateMemory(): Promise<{ state: ProductState; deprecated: number }>;
  updateMemoryCandidate(id: string, text: string): Promise<ProductState>;
  deprecateMemoryRecord(id: string, reason?: string): Promise<ProductState>;
  /** Edit a confirmed long-term memory's text; the server recomputes its embedding. */
  updateMemoryRecordText(id: string, text: string): Promise<ProductState>;
  deleteMemoryRecord(id: string): Promise<ProductState>;
  saveState(state: ProductState): Promise<{ state: ProductState; conflicted: boolean }>;
  /** F-03:成功时附带服务端逐库清理回执(见 {@link ResetReceipt});部分失败抛 ApiError(500, body 含 state+resetReceipt)。 */
  resetState(): Promise<ProductState & { resetReceipt?: ResetReceipt }>;
  createSearchBrief(input: CreateSearchBriefRequest): Promise<CreateSearchBriefResponse>;
  refreshSearchBrief(id: string): Promise<RefreshSearchBriefResponse>;
  trackSearchBrief(id: string, tracked: boolean): Promise<TrackSearchBriefResponse>;
  createAutoBrief(input: CreateAutoBriefRequest): Promise<CreateAutoBriefResponse>;
  autoRunResearch(): Promise<AutoRunResearchResponse>;
  createInterviewSession(input: CreateInterviewSessionRequest): Promise<InterviewSessionResponse>;
  sendInterviewTurn(sessionId: string, input: SendInterviewTurnRequest, signal?: AbortSignal): Promise<InterviewSessionResponse>;
  sendInterviewTurnStream(
    sessionId: string,
    input: SendInterviewTurnRequest,
    handlers?: {
      onDelta?: (text: string) => void;
      onUserPersisted?: (session: InterviewSession) => void;
      signal?: AbortSignal;
    }
  ): Promise<InterviewSessionResponse & { assistantText?: string; prosody?: unknown; aborted?: boolean; assistantTurnId?: string }>;
  cancelInterviewTurn(sessionId: string): Promise<{ ok: boolean }>;
  recordInterviewTurn(
    sessionId: string,
    input: {
      role: "user" | "assistant";
      content: string;
      intent?: string;
      referencedMemory?: string;
      strategy?: string;
      strategyDecision?: InterviewSession["strategyTrace"] extends (infer T)[] | undefined ? T : never;
    }
  ): Promise<InterviewSessionResponse>;
  classifyTurnComplete(sessionId: string, transcript: string, signal?: AbortSignal): Promise<{ done: boolean; reason: string }>;
  logCascadeDecision(sessionId: string, trace: { layer: number; action: string; reason: string; silenceMs: number; expressionState: string; transcript: string }): Promise<void>;
  applyInterviewControl(sessionId: string, input: ApplyInterviewControlRequest): Promise<InterviewSessionResponse>;
  endInterviewSession(sessionId: string): Promise<EndInterviewSessionResponse>;
  discardInterviewSession(sessionId: string): Promise<{ state: ProductState }>;
  generateInterviewPreSignals(sessionId: string): Promise<GeneratePreSignalsResponse>;
  /**
   * Fetch the assembled raw-material record (evidence chain) for a session.
   * Returns null when the backend has none yet (404) — the caller renders an
   * empty state instead of treating it as an error.
   */
  getRawMaterial(sessionId: string): Promise<InterviewRawMaterial | null>;
  /**
   * 🔴-1: recompute the realtime (omni) voice model's instructions against the
   * freshest user utterance so its memory recall tracks the conversation. The client
   * pushes the returned string into the live connection via updateInstructions.
   */
  refreshVoiceInstructions(
    interviewSessionId: string,
    latestUserText?: string
  ): Promise<{
    instructions: string;
    session?: InterviewSession;
    state?: ProductState;
    guidePersisted?: boolean;
  }>;
  createRealtimeVoiceSession(input: CreateRealtimeVoiceSessionRequest): Promise<RealtimeVoiceSessionResponse>;
  /**
   * LiveKit 接入 token。走 authedFetch（production bearer 鉴权下裸 fetch 恒 401）。
   * interviewSessionId 允许空串（当前没有进行中的访谈会话），与原有请求格式一致。
   */
  getLivekitToken(sessionId: string, interviewSessionId?: string): Promise<{ token: string; serverUrl?: string }>;
  exchangeRealtimeVoiceSdp(signalingPath: string, offerSdp: string): Promise<string>;
  interruptRealtimeVoiceSession(
    sessionId: string,
    input: InterruptRealtimeVoiceSessionRequest
  ): Promise<InterruptRealtimeVoiceSessionResponse>;
  generatePodcastEpisode(input: GeneratePodcastEpisodeRequest): Promise<GeneratePodcastEpisodeResponse>;
  synthesizePodcastEpisode(episodeId: string, script?: string): Promise<GeneratePodcastEpisodeResponse>;
  /** Delete one podcast episode; returns authoritative product state. */
  deletePodcastEpisode(episodeId: string): Promise<ProductState>;
  transcribeCorpusAudio(input: AudioTranscriptionInput): Promise<TranscribeCorpusAudioResponse>;
  analyzeCorpusImport(input: CorpusImportInput, focus?: string): Promise<AnalyzeCorpusImportResponse>;
  listVoices(): Promise<VoiceListResponse>;
  createVoice(input: CreateVoiceRequest): Promise<VoiceInfo>;
  deleteVoice(voiceId: string): Promise<void>;
  /**
   * Upload the whole-session voice recording. Best-effort: callers must not let a
   * failure block ending the interview. recordingStartedAt (ISO wall-clock at the
   * moment recording began) lets the viewer align each turn to a seek offset.
   */
  uploadSessionAudio(
    sessionId: string,
    blob: Blob,
    durationMs?: number,
    recordingStartedAt?: string,
    role?: SessionAudioRole
  ): Promise<void>;
  /** Metadata for a session's stored audio (exists:false when none). role defaults to interviewee. */
  getSessionAudioMeta(sessionId: string, role?: SessionAudioRole): Promise<SessionAudioMeta>;
  /** Absolute URL to stream the stored audio, for an <audio src>. */
  sessionAudioUrl(sessionId: string, role?: SessionAudioRole): string;
  /**
   * Fetch the stored audio as a Blob via fetch (so any client-configured auth
   * header rides along) rather than handing the URL to a native <audio src>,
   * which cannot carry an Authorization header and 401s under production bearer
   * auth. Returns null when no audio exists yet (404); throws ApiError on other
   * non-2xx. Caller wraps the Blob in URL.createObjectURL for playback.
   */
  fetchSessionAudioBlob(sessionId: string, role?: SessionAudioRole): Promise<Blob | null>;
}

/** Which speaker's audio track. interviewee (受访者麦克风录音) is the default;
 *  interviewer (主持人 TTS 合成音) is the bypass-tapped host stream. */
export type SessionAudioRole = "interviewee" | "interviewer";

export interface SessionAudioMeta {
  exists: boolean;
  mime?: string;
  byteSize?: number;
  durationMs?: number | null;
  /** ISO wall-clock of when recording started; used to align turns to seek offsets. */
  recordingStartedAt?: string | null;
}

export type SystemCapabilityStatus = "ready" | "degraded" | "needs-key" | "needs-endpoint" | "disabled";
export type SystemCapabilityKind = "runtime" | "storage" | "search" | "llm" | "voice";

export interface SystemCapability {
  id: string;
  kind: SystemCapabilityKind;
  label: string;
  status: SystemCapabilityStatus;
  active: boolean;
  detail: string;
  requiredEnv: string[];
  model?: string;
  transport?: string;
  lastCheckedAt: string;
}

export interface SystemCapabilitiesResponse {
  generatedAt: string;
  configVersion: string;
  runtime: {
    service: string;
    // R7:持久档从 sqlite 换成 surreal(唯一持久档);memory 为不持久档。
    stateStore: "memory" | "surreal";
  };
  capabilities: SystemCapability[];
}

export type SystemConfigSectionId = "secrets" | "models" | "search" | "voice" | "storage";
export type SystemConfigValueKind = "secret" | "string" | "number" | "boolean" | "select";

export interface SystemConfigSetting {
  key: string;
  section: SystemConfigSectionId;
  label: string;
  description: string;
  valueKind: SystemConfigValueKind;
  secret: boolean;
  required: boolean;
  configured: boolean;
  value: string | null;
  maskedValue?: string;
  defaultValue?: string;
  options?: Array<{ label: string; value: string }>;
  restartRequired: boolean;
}

export interface SystemConfigSection {
  id: SystemConfigSectionId;
  label: string;
  settings: SystemConfigSetting[];
}

export interface SystemConfigResponse {
  generatedAt: string;
  envFilePath?: string;
  sections: SystemConfigSection[];
}

export type SystemConfigUpdateRequest = Record<string, string | boolean | number | null>;

export interface SystemConfigUpdateResponse {
  settingsUpdated: string[];
  config: SystemConfigResponse;
}

export interface CreateSearchBriefRequest {
  topic: string;
  providerId: SearchProviderId;
  maxSources: number;
  recencyDays: number;
}

export interface CreateSearchBriefResponse {
  brief: SearchBrief;
  state: ProductState;
  task: CapabilityTask<SearchBriefInput>;
}

export interface CreateAutoBriefRequest {
  themeId?: string;
  debtId?: string;
}

export interface RefreshSearchBriefResponse {
  brief: SearchBrief;
  state: ProductState;
}

export interface TrackSearchBriefResponse {
  brief: SearchBrief;
  state: ProductState;
}

export interface CreateAutoBriefResponse {
  brief: SearchBrief;
  state: ProductState;
}

export interface AutoRunResearchResponse {
  state: ProductState;
  summary: {
    generated: number;
    refreshed: number;
    dedupedSources: number;
    /** Count of agenda items that failed (provider error). Omitted by older servers. */
    failed?: number;
    failures?: Array<{ topic?: string; error?: string } | string>;
  };
}

export interface ReviewsResponse {
  monthly: MonthlyReview;
  yearly: YearlyReview;
  radar: CognitiveRadar;
}

export interface ImportDocumentRequest {
  title: string;
  content: string;
  sourceType?: "text" | "webpage";
  sourceUrl?: string;
}

export interface ImportDocumentResponse {
  sourceId: string;
  candidateCount: number;
  state: ProductState;
  chunkCount?: number;
  embeddedChunkCount?: number;
  embeddingFailedCount?: number;
  embeddingReady?: boolean;
  vectorRecallAvailable?: boolean;
  reindexFailed?: boolean;
  reindexStaleDiscarded?: boolean;
  warning?: string;
}

/** 与 apps/api routes/rag.ts RagCitation 对齐：仅导入资料块引用。 */
export interface RagCitation {
  id: string;
  title: string;
  sourceUrl?: string;
  /** 1-based index matching `[n]` markers in the answer body. */
  citationIndex?: number;
}

export interface RagQueryResponse {
  answer: string;
  citations: RagCitation[];
}

export interface CreateInterviewSessionRequest {
  mode: InterviewMode;
  strength: InterviewStrength;
  searchBriefId?: string;
  /** Theme/track revisit: create-time topic for prefetch & guide (AS-P0-01). */
  topicHint?: string;
  /** 创建时软归属主题线，使 Track 在结束前也能聚合进行中会话。 */
  relatedThemeIds?: string[];
  /** Client-generated id for create retries; server dedupes by this key. */
  clientRequestId?: string;
}

export interface SendInterviewTurnRequest {
  content: string;
}

export interface ApplyInterviewControlRequest {
  action: InterviewControlAction;
}

export interface InterviewSessionResponse {
  session: InterviewSession;
  state: ProductState;
  preSignals?: InteractionPreSignals;
}

export interface EndInterviewSessionResponse extends InterviewSessionResponse {
  note: DualTrackNote;
  /** Pending HITL candidates not yet in long-term/vector recall. */
  pendingMemoryCandidateCount?: number;
  longTermRecallRequiresApproval?: boolean;
}

export interface GeneratePreSignalsResponse {
  preSignals: InteractionPreSignals;
  session: InterviewSession;
}

export interface CreateRealtimeVoiceSessionRequest {
  instructions?: string;
  interviewSessionId?: string;
  voice?: string;
}

export interface RealtimeVoiceSessionResponse {
  provider: "bailian";
  model: string;
  fallbackModel: string;
  transport: "webrtc" | "websocket";
  fallbackTransport: "websocket";
  vad: "server_vad" | "client_vad";
  enableSearch: boolean;
  configured: boolean;
  apiKeyConfigured: boolean;
  webrtcEndpointConfigured: boolean;
  requiresServerSession: boolean;
  sessionId: string;
  status: "ready" | "not-configured" | "needs-webrtc-endpoint";
  signaling: {
    method: "POST";
    path: string;
    contentType: "application/sdp";
  };
  sessionUpdate: {
    type: "session.update";
    session: {
      modalities: ["text", "audio"];
      voice: string;
      input_audio_format: "pcm";
      output_audio_format: "pcm";
      instructions: string;
      turn_detection: {
        type: "server_vad" | "semantic_vad";
        threshold: number;
        silence_duration_ms: number;
      };
    };
  };
  interviewSessionId?: string;
  expiresAt: string;
  /** Scripted opening line sourced from card.suggestedOpening.
   * When present the WS client sends an initial response.create on connect
   * so the AI proactively opens with this question (no improvised small-talk). */
  openingLine?: string;
}

export interface InterruptRealtimeVoiceSessionRequest {
  spokenTextSoFar?: string;
  interruptedAtMs?: number;
  assistantTurnId?: string;
  providerTurnId?: string;
  reason?: "user_interrupt" | "provider_error";
}

export interface InterruptRealtimeVoiceSessionResponse {
  interrupted: boolean;
  sessionId: string;
  truncated: boolean;
  spokenChars: number;
  originalChars: number;
  assistantTurnId?: string;
  providerTurnId?: string;
}

export interface GeneratePodcastEpisodeRequest {
  // P3-05:sourceType/sourceId 本就被后端消费(note 之外的 theme/search-brief/knowledge-debt 源),
  // 此前不在类型里、前端靠 as any 走私 → 编译期契约失效。补进契约:noteId 仅 note 源必带,
  // 其它源用 sourceType+sourceId。
  noteId?: string;
  sourceType?: PodcastEpisode["sourceType"];
  sourceId?: string;
  format: PodcastEpisode["format"];
  voice: string;
}

export interface GeneratePodcastEpisodeResponse {
  episode: PodcastEpisode;
  state: ProductState;
}

export interface TranscribeCorpusAudioResponse {
  transcription: AudioTranscription;
}

export interface AnalyzeCorpusImportResponse {
  insight: CorpusInsight;
  state: ProductState;
}

export interface VoiceInfo {
  voice: string;
  name: string;
  description: string;
  targetModel?: string;
  createdAt?: string;
}

export interface VoiceListResponse {
  preset: VoiceInfo[];
  custom: VoiceInfo[];
}

export interface CreateVoiceRequest {
  audioBase64: string;
  preferredName?: string;
}

export function getProductApiBaseUrl() {
  // 空字符串表示同源（生产 compose / 子路径反代）；仅 undefined 才回退本机 :3210
  const raw = import.meta.env.VITE_PRODUCT_API_BASE_URL;
  if (raw === undefined || raw === null) return "http://127.0.0.1:3210";
  return String(raw);
}

/**
 * Derive the realtime voice WebSocket origin from the configured product API base.
 * Never hardcode :3210 when a non-default HTTP API port is configured.
 * Supports absolute URL and same-origin relative base (e.g. "/zhuanfang").
 */
export function deriveRealtimeApiWsBaseUrl(productApiBaseUrl = getProductApiBaseUrl()): string {
  const raw = (productApiBaseUrl || "").trim();
  if (typeof location !== "undefined" && location.protocol === "https:") {
    return `wss://${location.host}`;
  }
  if (raw) {
    try {
      const base =
        typeof location !== "undefined" && location.origin
          ? location.origin
          : "http://127.0.0.1:3210";
      const u = new URL(raw, base);
      const wsProto = u.protocol === "https:" ? "wss:" : "ws:";
      // 相对路径部署时 WS 走同 host + 路径前缀（nginx /zhuanfang/ 已 Upgrade）
      if (raw.startsWith("/")) {
        return `${wsProto}//${u.host}${u.pathname.replace(/\/$/, "")}`;
      }
      return `${wsProto}//${u.host}`;
    } catch {
      /* fall through */
    }
  }
  if (typeof location !== "undefined" && location.hostname) {
    // 同源空 base：优先当前 host（经 80 反代），不再默认 :3210（公网常被安全组拦截）
    if (!raw) {
      const wsProto = location.protocol === "https:" ? "wss:" : "ws:";
      return `${wsProto}//${location.host}`;
    }
    return `ws://${location.hostname}:3210`;
  }
  return "ws://127.0.0.1:3210";
}

/** Runtime auth token: Vite bake-in OR window bootstrap from /api/runtime-bootstrap (not only static bundle). */
export function resolveProductApiToken(): string {
  const fromEnv = (import.meta.env.VITE_PRODUCT_API_TOKEN ?? "").trim();
  if (fromEnv) return fromEnv;
  if (typeof window !== "undefined") {
    const w = window as unknown as { __PRODUCT_API_TOKEN__?: string };
    if (typeof w.__PRODUCT_API_TOKEN__ === "string" && w.__PRODUCT_API_TOKEN__.trim()) {
      return w.__PRODUCT_API_TOKEN__.trim();
    }
    try {
      const fromSession = sessionStorage.getItem("product_api_token");
      if (fromSession && fromSession.trim()) return fromSession.trim();
    } catch { /* private mode */ }
  }
  return "";
}

/** Attach token to a realtime WS URL as ?token= (browser WS cannot set Authorization headers). */
export function withAuthTokenQuery(wsUrl: string, token = resolveProductApiToken()): string {
  if (!token) return wsUrl;
  try {
    const u = new URL(wsUrl);
    if (!u.searchParams.get("token")) u.searchParams.set("token", token);
    return u.toString();
  } catch {
    const sep = wsUrl.includes("?") ? "&" : "?";
    return `${wsUrl}${sep}token=${encodeURIComponent(token)}`;
  }
}

/**
 * Thrown when the API returns a non-2xx status — i.e. the server WAS reachable and
 * answered with a business error. Distinguished from a thrown fetch (network down)
 * so callers don't mistake a 422/409 for "backend offline" and tear down persistence.
 */
export class ApiError extends Error {
  /**
   * 审计修复 F-03:携带解析后的响应 body(若可解析)。reset 部分失败(500)的响应里带着
   * `state`(热态已清的事实)与 `resetReceipt`(逐库清理结果),前端 catch 需要据此如实
   * 提示"哪些库未清空"而不是笼统报错。可选参数,既有 2 参调用点行为不变。
   */
  constructor(public readonly status: number, path: string, public readonly body?: unknown) {
    super(`Product API request failed: ${status} (${path})`);
    this.name = "ApiError";
  }
}

/**
 * F-03:reset 单库清理结果,与后端 apps/api/src/routes/state.ts 的 reset/purge 端点对齐:
 * "cleared" | "not-configured" | "failed: <原因>"(not-configured 不算失败)。
 * P3-04:补 "rolled-back"——R2b 治理事务整体回滚时后端 rolledBackStores() 返回该值(冷热同回滚,
 * 一库不落),此前不在联合内 → 类型漂移(消费方 switch/展示逻辑对它一无所知)。
 */
export type ResetStoreOutcome = "cleared" | "not-configured" | "rolled-back" | `failed: ${string}`;

/** F-03:POST /api/state/reset 的逐库清理回执。 */
export interface ResetReceipt {
  partialFailure: boolean;
  /** P3-04:R2b 治理事务整体回滚时 true(热态未提交、无部分提交);stores 全 "rolled-back"。 */
  rolledBack?: boolean;
  stores: Record<string, ResetStoreOutcome>;
}

/**
 * 审计修复 F-04:legacy import(包内无 rawMaterials/audios 数组)的冷层去向,必须显式二选一:
 * - "preserve-cold":只替换热态,现有冷层(逐字稿/录音)原样保留;
 * - "replace-all":热态替换且旧冷层一并清空(热态与冷层同世代)。
 */
export type ColdLayerMode = "preserve-cold" | "replace-all";

/** F-04:POST /api/state/import 成功回执(冷层恢复数量 + 知识索引重建结果)。 */
export interface ImportReceipt {
  coldLayerMode?: ColdLayerMode;
  partial: boolean;
  restored: { rawMaterials: number; audios: number };
  skipped: {
    rawMaterials: Array<{ index: number; reason: string }>;
    audios: Array<{ index: number; reason: string }>;
  };
  missing: { audioSessions: string[] };
  knowledgeIndex: "rebuilt" | "failed" | "skipped";
}

export interface StateImportResult {
  state: ProductState;
  /** 旧服务端可能没有回执；新服务端成功响应恒有。null 时 UI 不得声称“完整恢复已验证”。 */
  receipt: ImportReceipt | null;
}

/** F-04:POST /api/state/purge 的逐库清理回执(三态口径与 reset 一致)。 */
export interface PurgeReceipt {
  partialFailure: boolean;
  /**
   * purge 的热态无论冷层成败都提交(隐私删除最大化)。B2 审查:部分失败(500)时后端把
   * 已清空的热态随 body{state, purgeReceipt} 带回,App.purgeData 据此采纳 body.state
   * (走 acceptAuthoritativeState)并如实列出未删除的库——见 src/App.tsx purgeData。
   */
  hotStateCommitted?: boolean;
  /** P3-04:R2b 治理事务整体回滚时 true(热态/冷层未提交);stores 全 "rolled-back"。 */
  rolledBack?: boolean;
  stores: Record<string, ResetStoreOutcome>;
}

/**
 * N-02:GET /api/health 的响应形状(route-agnostic 落库健康度数据源)。persist 字段仅在权威库
 * 连续落库失败(degraded)时出现——健康 / 内存档 / 旧后端一律不带该字段。前端低频轮询该端点,
 * 据 persist 驱动持久顶栏 banner,覆盖全部"200+异步落库"写路径(资产确认/记忆编辑等从不
 * PUT /api/state 却共享同一 persistQueue)。与后端 apps/api/src/routes/health.ts 的非泄漏形状
 * 对齐(不含 lastError 原文,避免内部错误串泄漏)。
 */
export interface HealthResponse {
  ok: boolean;
  service?: string;
  persist?: { degraded: boolean; consecutiveFailures: number; lastErrorAt?: string };
}

/**
 * N-02:持久顶栏 banner 的落库健康度快照(前端消费用轻量型)。由 getHealth 轮询得到的
 * {@link HealthResponse.persist} 派生:degraded 时为 { consecutiveFailures, lastErrorAt };
 * 健康 / 内存档 / 离线一律为 null(banner 消失)。只含 consecutiveFailures + lastErrorAt
 * (不含 lastError 原文,与 /api/health 的非泄漏形状一致)。consecutiveFailures 是"连续失败"
 * 语义:下一笔成功落库即清零,不因单次瞬态误报。
 */
export interface RuntimeMetricsLite {
  voice?: {
    /** Latency ring + event ring total (not equal to ttfaCount). */
    sampleCount?: number;
    /** Finite TTFA points only — use for latency window / SLO; prefer over sampleCount. */
    ttfaCount?: number;
    ttfaP50Ms?: number;
    ttfaP95Ms?: number;
    interruptCount?: number;
    bargeInSuccessCount?: number;
    bargeInSuccessRate?: number;
    interruptRecoveryCount?: number;
    interruptRecoveryRate?: number;
    /** Phase-0: false-trigger / echo-guard event totals. */
    falseTriggerCount?: number;
    falseTriggerByKind?: {
      quarantine_echo_suspect?: number;
      max_wait_suppressed?: number;
      auto_committed_echo_suspect?: number;
    };
    /** Per-stage latency percentiles (cascade reports segments when available). */
    segments?: {
      vadEndToStt?: { count?: number; p50Ms?: number; p95Ms?: number };
      sttToLlm?: { count?: number; p50Ms?: number; p95Ms?: number };
      llmTtft?: { count?: number; p50Ms?: number; p95Ms?: number };
      ttsTtfb?: { count?: number; p50Ms?: number; p95Ms?: number };
    };
    budgetHint?: { ttfaP50TargetMs?: number; ttfaP95TargetMs?: number; bargeInStopTargetMs?: number };
  };
  recall?: { eventCount?: number; hit?: number; empty?: number; low_score?: number; error?: number };
  grounding?: {
    eventCount?: number;
    grounded?: number;
    partial?: number;
    refused?: number;
    groundedAnswerRate?: number;
    refuseRate?: number;
    citationPresentRate?: number;
  };
}

export interface PersistHealthLite {
  consecutiveFailures: number;
  lastErrorAt?: string;
}

/** True when the error means the server was unreachable (fetch threw), not a 4xx/5xx. */
export function isNetworkError(err: unknown): boolean {
  return !(err instanceof ApiError);
}

/**
 * btoa over raw bytes. Building the binary string in chunks avoids the
 * "Maximum call stack size exceeded" that String.fromCharCode(...wholeArray)
 * hits on multi-MB recordings (spread explodes the arg list).
 */
export function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000; // 32KB per fromCharCode call
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, i + CHUNK);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

/**
 * Build the `?role=` query suffix for the session-audio endpoints. Returns "" for
 * the default (interviewee) so existing callers keep hitting the bare URL — only
 * an explicit role=interviewer appends the query. Keeps the interviewee contract
 * (and its tests) byte-for-byte unchanged.
 */
export function roleQuery(role?: SessionAudioRole): string {
  return role === "interviewer" ? "?role=interviewer" : "";
}

export class InterviewTurnRequestTimeoutError extends Error {
  readonly retryable = true;

  constructor(public readonly timeoutMs: number) {
    super(`专访追问等待超过 ${Math.ceil(timeoutMs / 1000)} 秒。本轮没有记录，请原样重试。`);
    this.name = "InterviewTurnRequestTimeoutError";
  }
}

export function resolveClientTimeoutMs(explicit: number | undefined, envValue: string | undefined, fallback: number): number {
  const parsed = explicit ?? (envValue?.trim() ? Number(envValue) : Number.NaN);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(1, Math.min(600_000, Math.round(parsed)));
}

export function createDeadlineSignal(external: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromExternal = () => controller.abort(external?.reason);

  if (external?.aborted) {
    abortFromExternal();
  } else {
    external?.addEventListener("abort", abortFromExternal, { once: true });
  }

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException(`Interview turn timed out after ${timeoutMs}ms.`, "TimeoutError"));
  }, timeoutMs);

  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    dispose: () => {
      clearTimeout(timer);
      external?.removeEventListener("abort", abortFromExternal);
    }
  };
}

export interface ProductApiClientOptions {
  interviewTurnTimeoutMs?: number;
}

