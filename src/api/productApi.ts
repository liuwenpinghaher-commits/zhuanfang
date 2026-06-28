import { normalizeProductState } from "../domain/storage";
import type { BackupRestoreRehearsalReport } from "../domain/backup";
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
  health(): Promise<boolean>;
  exportState(): Promise<BackupRestoreRehearsalReport>;
  importState(payload: unknown): Promise<ProductState>;
  getPrivacyReport(): Promise<PrivacyReport>;
  purgeState(): Promise<ProductState>;
  getSystemCapabilities(): Promise<SystemCapabilitiesResponse>;
  getSystemConfig(): Promise<SystemConfigResponse>;
  updateSystemConfig(updates: SystemConfigUpdateRequest): Promise<SystemConfigUpdateResponse>;
  getState(): Promise<ProductState>;
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
  approveMemoryCandidate(id: string): Promise<ProductState>;
  rejectMemoryCandidate(id: string, reviewNote?: string): Promise<ProductState>;
  consolidateMemory(): Promise<{ state: ProductState; deprecated: number }>;
  updateMemoryCandidate(id: string, text: string): Promise<ProductState>;
  deprecateMemoryRecord(id: string, reason?: string): Promise<ProductState>;
  deleteMemoryRecord(id: string): Promise<ProductState>;
  saveState(state: ProductState): Promise<{ state: ProductState; conflicted: boolean }>;
  resetState(): Promise<ProductState>;
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
  lastCheckedAt: string;
}

export interface SystemCapabilitiesResponse {
  generatedAt: string;
  configVersion: string;
  runtime: {
    service: string;
    stateStore: "memory" | "sqlite";
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
  noteId: string;
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
  constructor(public readonly status: number, path: string) {
    super(`Product API request failed: ${status} (${path})`);
    this.name = "ApiError";
  }
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

export function createProductApiClient(baseUrl = getProductApiBaseUrl(), fetchImpl: FetchLike = fetch): ProductApiClient {
  const normalizedBaseUrl = baseUrl.replace(/\/$/, "");
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
      throw new ApiError(response.status, path);
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
    async health() {
      try {
        const response = await authedFetch(`${normalizedBaseUrl}/api/health`, { method: "GET" });
        return response.ok;
      } catch {
        return false;
      }
    },
    async exportState() {
      return (await requestJson("/api/state/export", { method: "GET" })) as BackupRestoreRehearsalReport;
    },
    async importState(payload) {
      // The /import endpoint requires an explicit confirm token (REPLACE_ALL_STATE);
      // calling importState IS the intent to replace, so we attach it here.
      const body =
        payload && typeof payload === "object"
          ? { ...(payload as Record<string, unknown>), confirm: "REPLACE_ALL_STATE" }
          : { state: payload, confirm: "REPLACE_ALL_STATE" };
      return normalizeProductState(
        await requestJson("/api/state/import", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body)
        })
      );
    },
    async getPrivacyReport() {
      return (await requestJson("/api/state/privacy-report", { method: "GET" })) as PrivacyReport;
    },
    async purgeState() {
      return normalizeProductState(
        await requestJson("/api/state/purge", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ confirm: "PURGE_PERSONAL_DATA" })
        })
      );
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
        const body = (await response.json()) as { current: ProductState };
        return { state: normalizeProductState(body.current), conflicted: true };
      }
      if (!response.ok) {
        throw new ApiError(response.status, "/api/state");
      }
      return { state: normalizeProductState(await response.json()), conflicted: false };
    },
    async resetState() {
      return normalizeProductState(await requestJson("/api/state/reset", { method: "POST" }));
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
      const response = (await requestJson(`/api/interview-sessions/${sessionId}/turns`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
        // Pass the barge-in AbortSignal so an interrupted cascade turn cancels the
        // in-flight LLM call server-side instead of letting it run to completion and
        // overwrite the user's newly-started turn (P0-D). Optional → backward compatible.
        ...(signal ? { signal } : {})
      })) as InterviewSessionResponse;

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
      const res = await fetch(`${normalizedBaseUrl}/api/interview-sessions/${sessionId}/turn-complete`, {
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
        await fetch(`${normalizedBaseUrl}/api/interview-sessions/${sessionId}/decisions`, {
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
      await authedFetch(`${normalizedBaseUrl}/api/realtime-voice/voices/${encodeURIComponent(voiceId)}`, {
        method: "DELETE"
      });
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

export const productApiClient = createProductApiClient();
