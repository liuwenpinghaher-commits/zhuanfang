import { normalizeProductState } from "../domain/storage";
import { assessStateExportCompleteness, type StateExportBundle } from "../domain/backup";
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

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

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
   * Ask the asset-grounded chat assistant. sessionId=null starts a new session;
   * the server appends both the user message and the grounded answer, then returns
   * the full replaced state plus the (new or existing) sessionId, the answer text
   * and its citations. The caller adopts the returned state and selects sessionId.
   */
  sendChatMessage(
    sessionId: string | null,
    message: string
  ): Promise<{ state: ProductState; sessionId: string; answer: string; citations: ChatCitation[] }>;
  confirmDecision(id: string): Promise<ProductState>;
  /** Apply a proposed PlaybookPatch (optionally with user-edited rules). Server is authoritative
   *  (CAS-guarded state machine); returns the persisted state. Throws on 404/409. */
  applyPlaybookPatch(id: string, overrideRules?: string[]): Promise<ProductState>;
  /** Revert an applied PlaybookPatch. Throws 404/422 (only applied records can be reverted). */
  revertPlaybookPatch(id: string): Promise<ProductState>;
  approveMemoryCandidate(id: string): Promise<ProductState>;
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
  recordInterviewTurn(sessionId: string, input: { role: "user" | "assistant"; content: string }): Promise<InterviewSessionResponse>;
  classifyTurnComplete(sessionId: string, transcript: string, signal?: AbortSignal): Promise<{ done: boolean; reason: string }>;
  logCascadeDecision(sessionId: string, trace: { layer: number; action: string; reason: string; silenceMs: number; expressionState: string; transcript: string }): Promise<void>;
  applyInterviewControl(sessionId: string, input: ApplyInterviewControlRequest): Promise<InterviewSessionResponse>;
  endInterviewSession(sessionId: string): Promise<EndInterviewSessionResponse>;
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
  refreshVoiceInstructions(interviewSessionId: string, latestUserText?: string): Promise<{ instructions: string }>;
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
  sessionAudioUrl(sessionId: string): string;
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
  configured?: boolean;
  availability?: "unknown" | "available" | "unavailable";
  lastErrorCode?: string;
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
}

export interface CreateInterviewSessionRequest {
  mode: InterviewMode;
  strength: InterviewStrength;
  searchBriefId?: string;
  topicHint?: string;
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
  return import.meta.env.VITE_PRODUCT_API_BASE_URL ?? "http://127.0.0.1:3210";
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

export class InterviewTurnRequestTimeoutError extends Error {
  readonly retryable = true;

  constructor(public readonly timeoutMs: number) {
    super(`专访追问等待超过 ${Math.ceil(timeoutMs / 1000)} 秒。本轮没有记录，请原样重试。`);
    this.name = "InterviewTurnRequestTimeoutError";
  }
}

export interface ProductApiClientOptions {
  interviewTurnTimeoutMs?: number;
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
function bytesToBase64(bytes: Uint8Array): string {
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
function roleQuery(role?: SessionAudioRole): string {
  return role === "interviewer" ? "?role=interviewer" : "";
}

export function createProductApiClient(
  baseUrl = getProductApiBaseUrl(),
  fetchImpl: FetchLike = fetch,
  options: ProductApiClientOptions = {}
): ProductApiClient {
  const normalizedBaseUrl = baseUrl.replace(/\/$/, "");
  const interviewTurnTimeoutMs = resolveClientTimeoutMs(
    options.interviewTurnTimeoutMs,
    import.meta.env.VITE_INTERVIEW_TURN_TIMEOUT_MS,
    45_000
  );
  // H 生产 bearer 鉴权:前端从 Vite env(VITE_PRODUCT_API_TOKEN)注入 token,所有请求自动附 Authorization。
  // 无 token(dev / 未配)→ 不附头,dev fail-open 行为不变;配了 token 的生产 profile 不再整站 401。
  const rawFetch = fetchImpl;
  const authedToken = (import.meta.env.VITE_PRODUCT_API_TOKEN ?? "").trim();
  const authedFetch: FetchLike = authedToken
    ? (url, init) => rawFetch(url, { ...init, headers: { ...((init?.headers as Record<string, string> | undefined) ?? {}), authorization: `Bearer ${authedToken}` } })
    : rawFetch;

  async function requestJson(path: string, init: RequestInit): Promise<unknown> {
    const response = await authedFetch(`${normalizedBaseUrl}${path}`, init);
    if (!response.ok) {
      // F-03:尽力解析错误 body 挂到 ApiError 上——reset 部分失败(500)的 body 带着
      // 热态 state 与 resetReceipt,前端要用;解析失败(非 JSON)不影响抛错本身。
      const errorBody: unknown = await response.json().catch(() => undefined);
      throw new ApiError(response.status, path, errorBody);
    }
    return response.json();
  }

  async function requestText(path: string, init: RequestInit): Promise<string> {
    const response = await authedFetch(`${normalizedBaseUrl}${path}`, init);
    if (!response.ok) {
      throw new ApiError(response.status, path);
    }
    return response.text();
  }

  return {
    async exportState() {
      const raw = (await requestJson("/api/state/export", { method: "GET" })) as StateExportBundle;
      // 兼容尚未热重启的新旧后端组合：正式类型要求这些字段，新服务端会原样给出；旧服务端
      // 缺字段时客户端保守补齐并重新判定，UI 仍不会把未知/遗漏备份误报成“完整”。
      const audioSessions = Array.isArray(raw.audioSessions) ? raw.audioSessions : [];
      const audios = Array.isArray(raw.audios) ? raw.audios : [];
      const audioOmittedSessions = Array.isArray(raw.audioOmittedSessions) ? raw.audioOmittedSessions : [];
      const fallbackImportLimit = 64 * 1024 * 1024;
      const fallbackBytes = new TextEncoder().encode(JSON.stringify(raw)).byteLength;
      const importCompatibility = raw.importCompatibility ?? {
        bytes: fallbackBytes,
        importBodyLimitBytes: fallbackImportLimit,
        exceedsImportLimit: fallbackBytes > fallbackImportLimit
      };
      return {
        ...raw,
        rawMaterials: Array.isArray(raw.rawMaterials) ? raw.rawMaterials : [],
        audioSessions,
        audios,
        audioOmittedSessions,
        bundleDigest: raw.bundleDigest ?? raw.package.stateDigest,
        importCompatibility,
        completeness:
          raw.completeness ??
          assessStateExportCompleteness({
            audioSessions,
            audios,
            audioOmittedSessions,
            importCompatibility,
            checks: raw.checks
          })
      };
    },
    async importState(payload, coldLayerMode) {
      // The /import endpoint requires an explicit confirm token (REPLACE_ALL_STATE);
      // calling importState IS the intent to replace, so we attach it here.
      // F-04:coldLayerMode 透传给后端(legacy 裸 state 包必须显式声明冷层去向,否则 422;
      // UI 接线是 C2 的事,这里先把通道打通)。
      const base =
        payload && typeof payload === "object"
          ? { ...(payload as Record<string, unknown>) }
          : { state: payload };
      const body = { ...base, confirm: "REPLACE_ALL_STATE", ...(coldLayerMode ? { coldLayerMode } : {}) };
      const raw = await requestJson("/api/state/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      // F-04:服务端把 importReceipt(装饰键)spread 进了 state 响应体,与 purge/reset 同口径
      // normalize 前先剥离,防止被 autosave 原样 PUT 回服务器寄生在持久化数据里。
      let importReceipt: ImportReceipt | undefined;
      if (raw && typeof raw === "object") {
        const record = raw as Record<string, unknown>;
        if (record.importReceipt && typeof record.importReceipt === "object") {
          importReceipt = record.importReceipt as ImportReceipt;
        }
        delete record.importReceipt;
      }
      const state = normalizeProductState(raw);
      return { state, receipt: importReceipt ?? null };
    },
    async getPrivacyReport() {
      return (await requestJson("/api/state/privacy-report", { method: "GET" })) as PrivacyReport;
    },
    async purgeState() {
      const payload = await requestJson("/api/state/purge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: "PURGE_PERSONAL_DATA" })
      });
      // 服务端把执行回执（artifactPurge/deletedScope/deletedCount/purgeReceipt）spread 进了
      // state 响应体。这些装饰键不属于 ProductState，一旦进了 state 会被 autosave 原样 PUT
      // 回服务器、寄生在持久化数据里——normalize 前先剥掉。
      let purgeReceipt: PurgeReceipt | undefined;
      if (payload && typeof payload === "object") {
        const record = payload as Record<string, unknown>;
        delete record.artifactPurge;
        delete record.deletedScope;
        delete record.deletedCount;
        // F-04/B2:purgeReceipt 剥离后以不可枚举属性透出(App.purgeData 整对象
        // saveProductState/JSON 序列化时不会寄生);App.purgeData 读该属性做 200 时的
        // partialFailure 防御检查,500 部分失败则走 ApiError.body 路径(见 PurgeReceipt 注释)。
        if (record.purgeReceipt && typeof record.purgeReceipt === "object") {
          purgeReceipt = record.purgeReceipt as PurgeReceipt;
        }
        delete record.purgeReceipt;
      }
      const state = normalizeProductState(payload) as ProductState & { purgeReceipt?: PurgeReceipt };
      if (purgeReceipt) {
        Object.defineProperty(state, "purgeReceipt", { value: purgeReceipt, enumerable: false, configurable: true });
      }
      return state;
    },
    async getSystemCapabilities() {
      return (await requestJson("/api/system/capabilities", { method: "GET" })) as SystemCapabilitiesResponse;
    },
    async getSystemConfig() {
      return (await requestJson("/api/system/config", { method: "GET" })) as SystemConfigResponse;
    },
    async updateSystemConfig(updates) {
      return (await requestJson("/api/system/config", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ updates })
      })) as SystemConfigUpdateResponse;
    },
    async getState() {
      return normalizeProductState(await requestJson("/api/state", { method: "GET" }));
    },
    async getHealth() {
      return (await requestJson("/api/health", { method: "GET" })) as HealthResponse;
    },
    async getReviews() {
      return (await requestJson("/api/reviews", { method: "GET" })) as ReviewsResponse;
    },
    async importDocument(input) {
      const response = (await requestJson("/api/import/documents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input)
      })) as ImportDocumentResponse;
      return { ...response, state: normalizeProductState(response.state) };
    },
    async rebuildKnowledgeIndex() {
      return (await requestJson("/api/knowledge/rebuild", { method: "POST" })) as { chunkCount: number };
    },
    async sendChatMessage(sessionId, message) {
      const response = (await requestJson("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...(sessionId ? { sessionId } : {}), message })
      })) as { state: ProductState; sessionId: string; answer: string; citations: ChatCitation[] };
      return { ...response, state: normalizeProductState(response.state) };
    },
    async confirmDecision(id) {
      const response = (await requestJson(`/api/assets/decisions/${id}/confirm`, { method: "POST" })) as { state: ProductState };
      return normalizeProductState(response.state);
    },
    async applyPlaybookPatch(id, overrideRules) {
      const response = (await requestJson(`/api/playbook-patches/${id}/apply`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(overrideRules && overrideRules.length > 0 ? { overrideRules } : {})
      })) as { state: ProductState };
      return normalizeProductState(response.state);
    },
    async revertPlaybookPatch(id) {
      const response = (await requestJson(`/api/playbook-patches/${id}/revert`, { method: "POST" })) as { state: ProductState };
      return normalizeProductState(response.state);
    },
    async approveMemoryCandidate(id) {
      const response = (await requestJson(`/api/memory-candidates/${id}/approve`, { method: "POST" })) as { state: ProductState };
      return normalizeProductState(response.state);
    },
    async rejectMemoryCandidate(id, reviewNote) {
      const response = (await requestJson(`/api/memory-candidates/${id}/reject`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reviewNote })
      })) as { state: ProductState };
      return normalizeProductState(response.state);
    },
    async consolidateMemory() {
      const response = (await requestJson("/api/memory/consolidate", { method: "POST" })) as {
        state: ProductState;
        summary: { deprecated: number };
      };
      return { state: normalizeProductState(response.state), deprecated: response.summary?.deprecated ?? 0 };
    },
    async updateMemoryCandidate(id, text) {
      const response = (await requestJson(`/api/memory-candidates/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text })
      })) as { state: ProductState };
      return normalizeProductState(response.state);
    },
    async deprecateMemoryRecord(id, reason) {
      const response = (await requestJson(`/api/memory-records/${id}/deprecate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason })
      })) as { state: ProductState };
      return normalizeProductState(response.state);
    },
    async updateMemoryRecordText(id, text) {
      const response = (await requestJson(`/api/memory-records/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text })
      })) as { state: ProductState };
      return normalizeProductState(response.state);
    },
    async deleteMemoryRecord(id) {
      const response = (await requestJson(`/api/memory-records/${id}`, { method: "DELETE" })) as { state: ProductState };
      return normalizeProductState(response.state);
    },
    async saveState(state) {
      const response = await authedFetch(`${normalizedBaseUrl}/api/state`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(state)
      });
      if (response.status === 409) {
        // N-06:只有 stale-revision 409 携带权威 current(state.ts PUT /api/state 恒带 { current: stored });
        // GovernanceInFlightError 409(治理进行中)只有 { error },无 current。缺 current 时**绝不**把 undefined
        // 喂给 normalizeProductState——那会捏造一份完整 demo 态,前端误当"服务端权威",冲突弹窗里"服务器版本"
        // 就是演示数据,用户选它即丢真实数据(灾难恢复空库重启的 stale-409 同理)。缺 current 按硬错误抛,
        // 走既有"非离线 4xx"路径(App autosave catch 显示"治理进行中/稍后自动重试",不撕毁持久化、不误当离线)。
        const body = (await response.json().catch(() => ({}))) as { current?: unknown };
        if (!body || typeof body.current !== "object" || body.current === null) {
          throw new ApiError(409, "/api/state", body);
        }
        return { state: normalizeProductState(body.current), conflicted: true };
      }
      if (!response.ok) {
        throw new ApiError(response.status, "/api/state");
      }
      // N-02:PUT 响应不再携带 persistHealth 装饰键(落库降级信号改由 getHealth 轮询驱动 banner,
      // 见 getHealth / HealthResponse)。保持与其它保存路径一致的纯净 { state, conflicted }。
      return { state: normalizeProductState(await response.json()), conflicted: false };
    },
    async resetState() {
      const payload = await requestJson("/api/state/reset", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: "RESET_ALL_DATA" })
      });
      // F-03:服务端把 resetReceipt(逐库清理回执)spread 进了 state 响应体。它是装饰键,
      // 不属于 ProductState——与 purgeState 同口径,normalize 前先剥离,避免被 autosave
      // 原样 PUT 回服务器寄生在持久化数据里;再作为附加字段透给调用方(App 据此防御性
      // 检查 partialFailure,理论上 200 时恒为 false)。
      let resetReceipt: ResetReceipt | undefined;
      if (payload && typeof payload === "object") {
        const record = payload as Record<string, unknown>;
        if (record.resetReceipt && typeof record.resetReceipt === "object") {
          resetReceipt = record.resetReceipt as ResetReceipt;
        }
        delete record.resetReceipt;
      }
      const state = normalizeProductState(payload) as ProductState & { resetReceipt?: ResetReceipt };
      if (resetReceipt) {
        state.resetReceipt = resetReceipt;
      }
      return state;
    },
    async createSearchBrief(input) {
      const response = (await requestJson("/api/search/briefs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input)
      })) as CreateSearchBriefResponse;

      return {
        ...response,
        state: normalizeProductState(response.state)
      };
    },
    async refreshSearchBrief(id) {
      const response = (await requestJson(`/api/search/briefs/${encodeURIComponent(id)}/refresh`, {
        method: "POST"
      })) as RefreshSearchBriefResponse;
      return {
        ...response,
        state: normalizeProductState(response.state)
      };
    },
    async trackSearchBrief(id, tracked) {
      const response = (await requestJson(`/api/search/briefs/${encodeURIComponent(id)}/track`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tracked })
      })) as TrackSearchBriefResponse;
      return {
        ...response,
        state: normalizeProductState(response.state)
      };
    },
    async createAutoBrief(input) {
      const response = (await requestJson("/api/search/auto-briefs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input)
      })) as CreateAutoBriefResponse;

      return {
        ...response,
        state: normalizeProductState(response.state)
      };
    },
    async autoRunResearch() {
      const response = (await requestJson("/api/research/auto-run", {
        method: "POST"
      })) as AutoRunResearchResponse;

      return {
        ...response,
        state: normalizeProductState(response.state)
      };
    },
    async createInterviewSession(input) {
      const response = (await requestJson("/api/interview-sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input)
      })) as InterviewSessionResponse;

      return {
        ...response,
        state: normalizeProductState(response.state)
      };
    },
    async sendInterviewTurn(sessionId, input, signal) {
      const deadline = createDeadlineSignal(signal, interviewTurnTimeoutMs);
      let response: InterviewSessionResponse;
      try {
        response = (await requestJson(`/api/interview-sessions/${sessionId}/turns`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
          // 外部 signal 保留语音打断语义；内部 deadline 保证普通文本提交也一定退出等待态。
          signal: deadline.signal
        })) as InterviewSessionResponse;
      } catch (error) {
        if (deadline.didTimeout()) {
          throw new InterviewTurnRequestTimeoutError(interviewTurnTimeoutMs);
        }
        throw error;
      } finally {
        deadline.dispose();
      }

      return {
        ...response,
        state: normalizeProductState(response.state)
      };
    },
    async recordInterviewTurn(sessionId, input) {
      const response = (await requestJson(`/api/interview-sessions/${sessionId}/record-turn`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input)
      })) as InterviewSessionResponse;

      return {
        ...response,
        state: normalizeProductState(response.state)
      };
    },
    async classifyTurnComplete(sessionId, transcript, signal) {
      // authedFetch（非裸 fetch）：production bearer 鉴权下裸 fetch 恒 401，
      // 级联判停会永远走 http-error fail-safe。失败语义保持不变（!ok → 立即应答）。
      const res = await authedFetch(`${normalizedBaseUrl}/api/interview-sessions/${sessionId}/turn-complete`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ transcript }),
        // Pass the barge-in AbortSignal so an interrupted turn cancels the in-flight
        // endpoint LLM call instead of letting it run to completion server-side.
        ...(signal ? { signal } : {})
      });
      if (!res.ok) return { done: true, reason: "http error → respond" };
      return res.json();
    },
    async logCascadeDecision(sessionId, trace) {
      try {
        // authedFetch：同 classifyTurnComplete，production 鉴权下裸 fetch 会 401 丢审计。
        await authedFetch(`${normalizedBaseUrl}/api/interview-sessions/${sessionId}/decisions`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify(trace)
        });
      } catch { /* best-effort audit */ }
    },
    async applyInterviewControl(sessionId, input) {
      const response = (await requestJson(`/api/interview-sessions/${sessionId}/control`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input)
      })) as InterviewSessionResponse;

      return {
        ...response,
        state: normalizeProductState(response.state)
      };
    },
    async endInterviewSession(sessionId) {
      const response = (await requestJson(`/api/interview-sessions/${sessionId}/end`, {
        method: "POST"
      })) as EndInterviewSessionResponse;

      return {
        ...response,
        state: normalizeProductState(response.state)
      };
    },
    async generateInterviewPreSignals(sessionId) {
      return (await requestJson(`/api/interview-sessions/${sessionId}/pre-signals`, {
        method: "POST"
      })) as GeneratePreSignalsResponse;
    },
    async getRawMaterial(sessionId) {
      // 404 is a valid "not assembled yet" answer, not an error — handle it via
      // fetchImpl directly since requestJson would throw ApiError on any non-2xx.
      const response = await authedFetch(`${normalizedBaseUrl}/api/sessions/${sessionId}/raw-material`, {
        method: "GET"
      });
      if (response.status === 404) {
        return null;
      }
      if (!response.ok) {
        throw new ApiError(response.status, `/api/sessions/${sessionId}/raw-material`);
      }
      return (await response.json()) as InterviewRawMaterial;
    },
    async refreshVoiceInstructions(interviewSessionId, latestUserText) {
      return (await requestJson(`/api/interview-sessions/${interviewSessionId}/voice-instructions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(latestUserText != null ? { latestUserText } : {})
      })) as { instructions: string };
    },
    async createRealtimeVoiceSession(input) {
      return (await requestJson("/api/realtime-voice/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input)
      })) as RealtimeVoiceSessionResponse;
    },
    async getLivekitToken(sessionId, interviewSessionId = "") {
      return (await requestJson(
        `/api/realtime-voice/livekit-token?sessionId=${encodeURIComponent(sessionId)}&interviewSessionId=${encodeURIComponent(interviewSessionId)}`,
        { method: "GET" }
      )) as { token: string; serverUrl?: string };
    },
    async exchangeRealtimeVoiceSdp(signalingPath, offerSdp) {
      return requestText(signalingPath, {
        method: "POST",
        headers: { "content-type": "application/sdp" },
        body: offerSdp
      });
    },
    async interruptRealtimeVoiceSession(sessionId, input) {
      return (await requestJson(`/api/realtime-voice/sessions/${sessionId}/interrupt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input)
      })) as InterruptRealtimeVoiceSessionResponse;
    },
    async generatePodcastEpisode(input) {
      const response = (await requestJson("/api/podcast/episodes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input)
      })) as GeneratePodcastEpisodeResponse;

      return {
        ...response,
        state: normalizeProductState(response.state)
      };
    },
    async synthesizePodcastEpisode(episodeId, script) {
      const response = (await requestJson(`/api/podcast/episodes/${encodeURIComponent(episodeId)}/synthesize`, {
        method: "POST",
        ...(script !== undefined
          ? { headers: { "content-type": "application/json" }, body: JSON.stringify({ script }) }
          : {})
      })) as GeneratePodcastEpisodeResponse;

      return {
        ...response,
        state: normalizeProductState(response.state)
      };
    },
    async transcribeCorpusAudio(input) {
      return (await requestJson("/api/corpus/transcriptions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input)
      })) as TranscribeCorpusAudioResponse;
    },
    async analyzeCorpusImport(input, focus) {
      const trimmedFocus = focus?.trim();
      const response = (await requestJson("/api/corpus/insights", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(trimmedFocus ? { ...input, focus: trimmedFocus } : input)
      })) as AnalyzeCorpusImportResponse;

      return {
        ...response,
        state: normalizeProductState(response.state)
      };
    },
    async listVoices() {
      return (await requestJson("/api/realtime-voice/voices", { method: "GET" })) as VoiceListResponse;
    },
    async createVoice(input) {
      return (await requestJson("/api/realtime-voice/voices", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input)
      })) as VoiceInfo;
    },
    async deleteVoice(voiceId) {
      const response = await authedFetch(`${normalizedBaseUrl}/api/realtime-voice/voices/${encodeURIComponent(voiceId)}`, {
        method: "DELETE"
      });
      // 不检查 ok 就返回 = 假成功：服务端 4xx/5xx 时前端仍把音色从列表移除。
      if (!response.ok) {
        throw new ApiError(response.status, `/api/realtime-voice/voices/${voiceId}`);
      }
    },
    async uploadSessionAudio(sessionId, blob, durationMs, recordingStartedAt, role) {
      // Prefer Blob.arrayBuffer() (real browsers); fall back to Response(blob)
      // for environments (jsdom) whose Blob lacks arrayBuffer.
      const arrayBuffer = typeof blob.arrayBuffer === "function"
        ? await blob.arrayBuffer()
        : await new Response(blob).arrayBuffer();
      const buf = new Uint8Array(arrayBuffer);
      const audioBase64 = bytesToBase64(buf);
      const response = await authedFetch(`${normalizedBaseUrl}/api/sessions/${sessionId}/audio${roleQuery(role)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          audioBase64,
          mime: blob.type || "audio/webm",
          ...(typeof durationMs === "number" ? { durationMs } : {}),
          ...(typeof recordingStartedAt === "string" ? { recordingStartedAt } : {})
        })
      });
      if (!response.ok) {
        throw new ApiError(response.status, `/api/sessions/${sessionId}/audio`);
      }
    },
    async getSessionAudioMeta(sessionId, role) {
      return (await requestJson(`/api/sessions/${sessionId}/audio/meta${roleQuery(role)}`, { method: "GET" })) as SessionAudioMeta;
    },
    async fetchSessionAudioBlob(sessionId, role) {
      // Use fetch (carries client-configured headers) instead of <audio src>,
      // which cannot send Authorization and 401s under production bearer auth.
      const response = await authedFetch(`${normalizedBaseUrl}/api/sessions/${sessionId}/audio${roleQuery(role)}`, {
        method: "GET"
      });
      if (response.status === 404) {
        return null;
      }
      if (!response.ok) {
        throw new ApiError(response.status, `/api/sessions/${sessionId}/audio`);
      }
      return response.blob();
    },
    sessionAudioUrl(sessionId) {
      // 用于 <audio src>。注意：原生 audio 元素无法附带 Authorization 头，因此若启用
      // production bearer 鉴权（DEPLOYMENT_PROFILE=production），此回放会 401。本地/dev
      // (fail-open) 正常。启用生产前需改为 ?token= 查询鉴权，或前端用 fetch+blob URL 回放。
      return `${normalizedBaseUrl}/api/sessions/${sessionId}/audio`;
    }
  };
}

function resolveClientTimeoutMs(explicit: number | undefined, envValue: string | undefined, fallback: number): number {
  const parsed = explicit ?? (envValue?.trim() ? Number(envValue) : Number.NaN);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(1, Math.min(600_000, Math.round(parsed)));
}

function createDeadlineSignal(external: AbortSignal | undefined, timeoutMs: number) {
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

export const productApiClient = createProductApiClient();
