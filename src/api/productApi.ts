import { normalizeProductState } from "../domain/storage";
import type { CapabilityTask } from "../capabilities/task";
import type {
  AudioTranscription,
  AudioTranscriptionInput,
  CognitiveRadar,
  CorpusImportInput,
  CorpusInsight,
  DualTrackNote,
  InteractionPreSignals,
  IntelItem,
  IntelTask,
  InterviewControlAction,
  InterviewMode,
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
  getSystemCapabilities(): Promise<SystemCapabilitiesResponse>;
  getSystemConfig(): Promise<SystemConfigResponse>;
  updateSystemConfig(updates: SystemConfigUpdateRequest): Promise<SystemConfigUpdateResponse>;
  getState(): Promise<ProductState>;
  getReviews(): Promise<ReviewsResponse>;
  importDocument(input: ImportDocumentRequest): Promise<ImportDocumentResponse>;
  approveMemoryCandidate(id: string): Promise<ProductState>;
  rejectMemoryCandidate(id: string, reviewNote?: string): Promise<ProductState>;
  updateMemoryCandidate(id: string, text: string): Promise<ProductState>;
  deprecateMemoryRecord(id: string, reason?: string): Promise<ProductState>;
  deleteMemoryRecord(id: string): Promise<ProductState>;
  createIntelTask(input: CreateIntelTaskRequest): Promise<{ task: IntelTask; state: ProductState }>;
  runIntelTask(taskId: string): Promise<{ count: number; state: ProductState }>;
  updateIntelItemStatus(itemId: string, status: IntelItem["status"]): Promise<ProductState>;
  intelItemToDebt(itemId: string): Promise<ProductState>;
  deleteIntelTask(taskId: string): Promise<ProductState>;
  saveState(state: ProductState): Promise<{ state: ProductState; conflicted: boolean }>;
  resetState(): Promise<ProductState>;
  createSearchBrief(input: CreateSearchBriefRequest): Promise<CreateSearchBriefResponse>;
  createAutoBrief(input: CreateAutoBriefRequest): Promise<CreateAutoBriefResponse>;
  createInterviewSession(input: CreateInterviewSessionRequest): Promise<InterviewSessionResponse>;
  sendInterviewTurn(sessionId: string, input: SendInterviewTurnRequest): Promise<InterviewSessionResponse>;
  recordInterviewTurn(sessionId: string, input: { role: "user" | "assistant"; content: string }): Promise<InterviewSessionResponse>;
  classifyTurnComplete(sessionId: string, transcript: string, signal?: AbortSignal): Promise<{ done: boolean; reason: string }>;
  logCascadeDecision(sessionId: string, trace: { layer: number; action: string; reason: string; silenceMs: number; expressionState: string; transcript: string }): Promise<void>;
  applyInterviewControl(sessionId: string, input: ApplyInterviewControlRequest): Promise<InterviewSessionResponse>;
  endInterviewSession(sessionId: string): Promise<EndInterviewSessionResponse>;
  generateInterviewPreSignals(sessionId: string): Promise<GeneratePreSignalsResponse>;
  createRealtimeVoiceSession(input: CreateRealtimeVoiceSessionRequest): Promise<RealtimeVoiceSessionResponse>;
  exchangeRealtimeVoiceSdp(signalingPath: string, offerSdp: string): Promise<string>;
  interruptRealtimeVoiceSession(
    sessionId: string,
    input: InterruptRealtimeVoiceSessionRequest
  ): Promise<InterruptRealtimeVoiceSessionResponse>;
  generatePodcastEpisode(input: GeneratePodcastEpisodeRequest): Promise<GeneratePodcastEpisodeResponse>;
  synthesizePodcastEpisode(episodeId: string): Promise<GeneratePodcastEpisodeResponse>;
  transcribeCorpusAudio(input: AudioTranscriptionInput): Promise<TranscribeCorpusAudioResponse>;
  analyzeCorpusImport(input: CorpusImportInput): Promise<AnalyzeCorpusImportResponse>;
  listVoices(): Promise<VoiceListResponse>;
  createVoice(input: CreateVoiceRequest): Promise<VoiceInfo>;
  deleteVoice(voiceId: string): Promise<void>;
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

export interface CreateAutoBriefResponse {
  brief: SearchBrief;
  state: ProductState;
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

export interface CreateIntelTaskRequest {
  name: string;
  keywords: string[];
  provider?: SearchProviderId;
  frequency?: IntelTask["frequency"];
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
  return import.meta.env.VITE_PRODUCT_API_BASE_URL ?? "http://127.0.0.1:8787";
}

export function createProductApiClient(baseUrl = getProductApiBaseUrl(), fetchImpl: FetchLike = fetch): ProductApiClient {
  const normalizedBaseUrl = baseUrl.replace(/\/$/, "");

  async function requestJson(path: string, init: RequestInit): Promise<unknown> {
    const response = await fetchImpl(`${normalizedBaseUrl}${path}`, init);
    if (!response.ok) {
      throw new Error(`Product API request failed: ${response.status}`);
    }
    return response.json();
  }

  async function requestText(path: string, init: RequestInit): Promise<string> {
    const response = await fetchImpl(`${normalizedBaseUrl}${path}`, init);
    if (!response.ok) {
      throw new Error(`Product API request failed: ${response.status}`);
    }
    return response.text();
  }

  return {
    async health() {
      try {
        const response = await fetchImpl(`${normalizedBaseUrl}/api/health`, { method: "GET" });
        return response.ok;
      } catch {
        return false;
      }
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
    async createIntelTask(input) {
      const response = (await requestJson("/api/intel/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input)
      })) as { task: IntelTask; state: ProductState };
      return { task: response.task, state: normalizeProductState(response.state) };
    },
    async runIntelTask(taskId) {
      const response = (await requestJson(`/api/intel/tasks/${taskId}/run`, { method: "POST" })) as {
        count: number;
        state: ProductState;
      };
      return { count: response.count, state: normalizeProductState(response.state) };
    },
    async updateIntelItemStatus(itemId, status) {
      const response = (await requestJson(`/api/intel/items/${itemId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status })
      })) as { state: ProductState };
      return normalizeProductState(response.state);
    },
    async intelItemToDebt(itemId) {
      const response = (await requestJson(`/api/intel/items/${itemId}/to-debt`, { method: "POST" })) as { state: ProductState };
      return normalizeProductState(response.state);
    },
    async deleteIntelTask(taskId) {
      const response = (await requestJson(`/api/intel/tasks/${taskId}`, { method: "DELETE" })) as { state: ProductState };
      return normalizeProductState(response.state);
    },
    async saveState(state) {
      const response = await fetchImpl(`${normalizedBaseUrl}/api/state`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(state)
      });
      if (response.status === 409) {
        const body = (await response.json()) as { current: ProductState };
        return { state: normalizeProductState(body.current), conflicted: true };
      }
      if (!response.ok) {
        throw new Error(`Product API request failed: ${response.status}`);
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
    async sendInterviewTurn(sessionId, input) {
      const response = (await requestJson(`/api/interview-sessions/${sessionId}/turns`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input)
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
    async synthesizePodcastEpisode(episodeId) {
      const response = (await requestJson(`/api/podcast/episodes/${encodeURIComponent(episodeId)}/synthesize`, {
        method: "POST"
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
    async analyzeCorpusImport(input) {
      const response = (await requestJson("/api/corpus/insights", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input)
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
      await fetchImpl(`${normalizedBaseUrl}/api/realtime-voice/voices/${encodeURIComponent(voiceId)}`, {
        method: "DELETE"
      });
    }
  };
}

export const productApiClient = createProductApiClient();
