/** Product API client factory (split from productApi.ts). */
import { normalizeProductState } from "../domain/storage";
import { assessStateExportCompleteness, type StateExportBundle } from "../domain/backup";
import type { PrivacyReport } from "../domain/privacy";
import type {
  ChatCitation,
  InterviewRawMaterial,
  InterviewSession,
  ProductState
} from "../domain/types";
import type {
  AnalyzeCorpusImportResponse,
  AutoRunResearchResponse,
  CreateAutoBriefResponse,
  CreateSearchBriefResponse,
  EndInterviewSessionResponse,
  FetchLike,
  GeneratePodcastEpisodeResponse,
  GeneratePreSignalsResponse,
  HealthResponse,
  ImportDocumentResponse,
  ImportReceipt,
  InterruptRealtimeVoiceSessionResponse,
  InterviewSessionResponse,
  ProductApiClient,
  ProductApiClientOptions,
  PurgeReceipt,
  RealtimeVoiceSessionResponse,
  RefreshSearchBriefResponse,
  ResetReceipt,
  ReviewsResponse,
  SendInterviewTurnRequest,
  SessionAudioMeta,
  SystemCapabilitiesResponse,
  SystemConfigResponse,
  SystemConfigUpdateResponse,
  TrackSearchBriefResponse,
  TranscribeCorpusAudioResponse,
  VoiceInfo,
  VoiceListResponse
} from "./productApi.types";
import {
  ApiError,
  bytesToBase64,
  createDeadlineSignal,
  deriveRealtimeApiWsBaseUrl,
  getProductApiBaseUrl,
  InterviewTurnRequestTimeoutError,
  isNetworkError,
  resolveClientTimeoutMs,
  resolveProductApiToken,
  roleQuery,
  withAuthTokenQuery
} from "./productApi.types";

export function createProductApiClient(
  baseUrl = getProductApiBaseUrl(),
  fetchImpl: FetchLike = fetch,
  options: ProductApiClientOptions = {}
): ProductApiClient {
  void options;
  const interviewTurnTimeoutMs = resolveClientTimeoutMs(
    options.interviewTurnTimeoutMs,
    (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env?.VITE_INTERVIEW_TURN_TIMEOUT_MS,
    120_000
  );
  const normalizedBaseUrl = baseUrl.replace(/\/$/, "");
  // H 生产 bearer 鉴权:前端从 Vite env(VITE_PRODUCT_API_TOKEN)注入 token,所有请求自动附 Authorization。
  // 无 token(dev / 未配)→ 不附头,dev fail-open 行为不变;配了 token 的生产 profile 不再整站 401。
  const rawFetch = fetchImpl;
  // Prefer runtime-resolved token (bootstrap / session) over bake-only Vite env.
  // When no token is configured, pass init through unchanged so unit tests and
  // local fail-open traffic keep byte-identical request shapes.
  const authedFetch: FetchLike = (url, init) => {
    const authedToken = resolveProductApiToken();
    // Production SPA relies on HttpOnly cookie from runtime-bootstrap → credentials:include.
    // Unit tests (VITEST) keep init byte-identical unless a token is configured.
    const underTest = typeof process !== "undefined" && Boolean(process.env.VITEST);
    if (!authedToken) {
      if (underTest) return rawFetch(url, init);
      return rawFetch(url, { ...init, credentials: init?.credentials ?? "include" });
    }
    const headers = { ...((init?.headers as Record<string, string> | undefined) ?? {}) };
    if (!headers.authorization && !headers.Authorization) {
      headers.authorization = `Bearer ${authedToken}`;
    }
    return rawFetch(url, {
      ...init,
      headers,
      credentials: init?.credentials ?? "include"
    });
  };

  async function requestJson(path: string, init: RequestInit): Promise<unknown> {
    const response = await authedFetch(`${normalizedBaseUrl}${path}`, init);
    if (!response.ok) {
      if (response.status === 401) {
        try {
          window.dispatchEvent(new CustomEvent("zf-auth-required"));
        } catch {
          /* non-browser */
        }
      }
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
      if (response.status === 401) {
        try {
          window.dispatchEvent(new CustomEvent("zf-auth-required"));
        } catch {
          /* non-browser */
        }
      }
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
    async reportVoiceLatency(sample: {
      path?: "cascade" | "omni" | "livekit" | "interrupt" | "unknown";
      ttfaMs?: number;
      vadEndToSttMs?: number;
      sttToLlmMs?: number;
      llmTtftMs?: number;
      ttsTtfbMs?: number;
      interrupted?: boolean;
      sessionId?: string;
    }): Promise<void> {
      try {
        await requestJson("/api/system/runtime-metrics/voice", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(sample)
        });
      } catch {
        /* best-effort telemetry — never block voice UX */
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
      })) as {
        state: ProductState;
        sessionId: string;
        answer: string;
        citations: ChatCitation[];
        groundingMode?: "grounded" | "partial" | "refused";
      };
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
    async approveMemoryCandidate(id, opts) {
      const response = (await requestJson(`/api/memory-candidates/${id}/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: opts?.mode ?? "merge" })
      })) as {
        state: ProductState;
        embeddingReady?: boolean;
        vectorRecallAvailable?: boolean;
        warning?: string;
      };
      return {
        state: normalizeProductState(response.state),
        ...(response.embeddingReady !== undefined ? { embeddingReady: response.embeddingReady } : {}),
        ...(response.vectorRecallAvailable !== undefined
          ? { vectorRecallAvailable: response.vectorRecallAvailable }
          : {}),
        ...(response.warning ? { warning: response.warning } : {})
      };
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

    async sendInterviewTurnStream(
      sessionId: string,
      input: SendInterviewTurnRequest,
      handlers: {
        onDelta?: (text: string) => void;
        signal?: AbortSignal;
      } = {}
    ): Promise<InterviewSessionResponse & { assistantText?: string; prosody?: unknown }> {
      const deadline = createDeadlineSignal(handlers.signal, interviewTurnTimeoutMs);
      try {
        const res = await authedFetch(`/api/interview-sessions/${encodeURIComponent(sessionId)}/turns/stream`, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "text/event-stream" },
          body: JSON.stringify(input),
          signal: deadline.signal
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new ApiError(res.status, text || res.statusText);
        }
        if (!res.body) throw new Error("Interview turn stream returned empty body.");
        const reader = res.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let buffer = "";
        let finalPayload: (InterviewSessionResponse & { assistantText?: string; prosody?: unknown }) | null = null;
        let streamError: string | null = null;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const chunks = buffer.split("\n\n");
          buffer = chunks.pop() ?? "";
          for (const chunk of chunks) {
            const lines = chunk.split("\n");
            let event = "message";
            let data = "";
            for (const line of lines) {
              if (line.startsWith("event:")) event = line.slice(6).trim();
              if (line.startsWith("data:")) data += line.slice(5).trim();
            }
            if (!data) continue;
            let parsed: any;
            try { parsed = JSON.parse(data); } catch { continue; }
            if (event === "delta" && typeof parsed.text === "string") {
              handlers.onDelta?.(parsed.text);
            } else if (event === "final") {
              finalPayload = {
                session: parsed.session,
                state: parsed.state,
                ...(parsed.preSignals ? { preSignals: parsed.preSignals } : {}),
                assistantText: parsed.assistantText,
                prosody: parsed.prosody
              };
            } else if (event === "error") {
              streamError = typeof parsed.error === "string" ? parsed.error : "stream error";
            }
          }
        }
        if (streamError) throw new Error(streamError);
        if (!finalPayload?.session || !finalPayload.state) {
          throw new Error("Interview turn stream ended without final payload.");
        }
        return {
          ...finalPayload,
          session: finalPayload.session,
          state: normalizeProductState(finalPayload.state)
        };
      } catch (error) {
        if (deadline.didTimeout()) {
          throw new InterviewTurnRequestTimeoutError(interviewTurnTimeoutMs);
        }
        throw error;
      } finally {
        deadline.dispose();
      }
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
    async discardInterviewSession(sessionId) {
      const response = (await requestJson(`/api/interview-sessions/${sessionId}/discard`, {
        method: "POST"
      })) as { state: ProductState };
      return { state: normalizeProductState(response.state) };
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
      })) as {
        instructions: string;
        session?: InterviewSession;
        state?: ProductState;
        guidePersisted?: boolean;
      };
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
    async deletePodcastEpisode(episodeId) {
      const response = (await requestJson(`/api/podcast/episodes/${encodeURIComponent(episodeId)}`, {
        method: "DELETE"
      })) as { state: ProductState };
      return normalizeProductState(response.state);
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
    sessionAudioUrl(sessionId, role) {
      // Native <audio src> cannot send Authorization. Prefer fetchSessionAudioBlob.
      // When a deploy-time/runtime token is available, attach ?token= for bare URL playback.
      const base = `${normalizedBaseUrl}/api/sessions/${sessionId}/audio${roleQuery(role)}`;
      const token = resolveProductApiToken();
      return token ? withAuthTokenQuery(base, token) : base;
    }
  };
}

export const productApiClient = createProductApiClient();
