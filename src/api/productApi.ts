import { normalizeProductState } from "../domain/storage";
import type { CapabilityTask } from "../capabilities/task";
import type {
  AudioTranscription,
  AudioTranscriptionInput,
  CorpusImportInput,
  CorpusInsight,
  DualTrackNote,
  InterviewControlAction,
  InterviewMode,
  InterviewSession,
  InterviewStrength,
  PodcastEpisode,
  ProductState,
  SearchBrief,
  SearchBriefInput,
  SearchProviderId
} from "../domain/types";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ProductApiClient {
  health(): Promise<boolean>;
  getSystemCapabilities(): Promise<SystemCapabilitiesResponse>;
  getSystemConfig(): Promise<SystemConfigResponse>;
  updateSystemConfig(updates: SystemConfigUpdateRequest): Promise<SystemConfigUpdateResponse>;
  getState(): Promise<ProductState>;
  saveState(state: ProductState): Promise<ProductState>;
  resetState(): Promise<ProductState>;
  createSearchBrief(input: CreateSearchBriefRequest): Promise<CreateSearchBriefResponse>;
  createInterviewSession(input: CreateInterviewSessionRequest): Promise<InterviewSessionResponse>;
  sendInterviewTurn(sessionId: string, input: SendInterviewTurnRequest): Promise<InterviewSessionResponse>;
  applyInterviewControl(sessionId: string, input: ApplyInterviewControlRequest): Promise<InterviewSessionResponse>;
  endInterviewSession(sessionId: string): Promise<EndInterviewSessionResponse>;
  createRealtimeVoiceSession(input: CreateRealtimeVoiceSessionRequest): Promise<RealtimeVoiceSessionResponse>;
  exchangeRealtimeVoiceSdp(signalingPath: string, offerSdp: string): Promise<string>;
  generatePodcastEpisode(input: GeneratePodcastEpisodeRequest): Promise<GeneratePodcastEpisodeResponse>;
  transcribeCorpusAudio(input: AudioTranscriptionInput): Promise<TranscribeCorpusAudioResponse>;
  analyzeCorpusImport(input: CorpusImportInput): Promise<AnalyzeCorpusImportResponse>;
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
}

export interface EndInterviewSessionResponse extends InterviewSessionResponse {
  note: DualTrackNote;
}

export interface CreateRealtimeVoiceSessionRequest {
  instructions?: string;
  interviewSessionId?: string;
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
    async saveState(state) {
      return normalizeProductState(
        await requestJson("/api/state", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(state)
        })
      );
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
    }
  };
}

export const productApiClient = createProductApiClient();
