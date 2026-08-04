/** Split from server.ts — keep constants co-located with registrars. */
import { MUTATING_METHODS } from "./write-gate";

import Fastify, { type FastifyRequest, type FastifyReply } from "fastify";
import fastifyStatic from "@fastify/static";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
// R7:sqlite 冷层与 dual-write/dual-surreal 已删除;持久化唯一走 surreal(startServer 经
// createSurrealStores 注入),buildApiServer 默认工厂只构造内存仓库。
import { loadLocalEnvFile } from "../env";
import { resolveProductStoreSelection, type ProductStoreMode } from "../store-selection";
import { createInMemoryProductStateRepository, StateRevisionConflictError, type ProductStateRepository } from "../product-state-repository";
import { createInMemoryRawMaterialRepository, type RawMaterialRepository } from "../raw-material-repository";
import { createInMemoryAudioRepository, type AudioRepository } from "../audio-repository";
import { createInMemoryKnowledgeIndexRepository, type KnowledgeIndexRepository } from "../knowledge-index-repository";
import { createAnySearchClientFromEnv, type AnySearchClient } from "../providers/anysearch";
import { createLocalEmbeddingClient } from "../providers/local-embedding";
import {
  createBailianAudioTranscriptionClientFromEnv,
  createBailianChatClientFromEnv,
  createBailianCharacterInterviewClientFromEnv,
  createBailianEmbeddingClientFromEnv,
  createBailianPodcastAudioClientFromEnv,
  createBailianRealtimeVoiceClientFromEnv,
  createBailianSearchClientFromEnv,
  createBailianVoiceEnrollmentClientFromEnv,
  type BailianAudioTranscriptionClient,
  type BailianChatClient,
  type BailianCharacterInterviewClient,
  type BailianEmbeddingClient,
  type BailianPodcastAudioClient,
  type BailianRealtimeVoiceClient,
  type BailianSearchClient,
  type BailianVoiceEnrollmentClient
} from "../providers/bailian";
import {
  createBailianStreamingTtsClient,
  type BailianStreamingTtsClient,
  type BailianStreamingTtsOptions
} from "../providers/bailian-streaming-tts";
import {
  bindRequestPrincipal,
  isAuthGuardActive,
  isAuthorized,
  isSessionAuthEnabled,
  readCookieToken,
  resolvePrincipal,
  SESSION_COOKIE
} from "../auth";
import { authenticateUser, ensureBootstrapUsers } from "../auth/users";
import { issueSessionToken, sessionCookieHeader } from "../auth/session";
import { currentUsername, enterPrincipal, legacyOwner } from "../auth/user-context";
import {
  createInMemoryUserRepoFactory,
  createUserScopedProductStateRepository
} from "../auth/user-scoped-repository";
import { createLlmBudget } from "../llm-budget";
import { createRateLimiter, rateLimitBucket } from "../rate-limit";
import { resolveRequestTimeoutMs } from "../request-timeout";
import { resolveBailianApiKey } from "../runtime-secrets";
import { registerAssetRoutes } from "../routes/assets";
import { registerCorpusRoutes } from "../routes/corpus";
import { registerHealthRoutes } from "../routes/health";
import { registerImportRoutes } from "../routes/import";
import { registerInterviewSessionRoutes } from "../routes/interview-sessions";
import { registerKnowledgeRoutes, reindexOnStateChange } from "../routes/knowledge";
import { registerRawMaterialRoutes } from "../routes/raw-material";
import { registerAudioRoutes } from "../routes/audio";
import { registerMemoryRecordRoutes } from "../routes/memory-records";
import { registerMemoryCandidateRoutes } from "../routes/memory-candidates";
import { registerPlaybookPatchRoutes } from "../routes/playbook-patches";
import { registerPodcastRoutes } from "../routes/podcast";
import { registerRagRoutes } from "../routes/rag";
import { registerChatRoutes } from "../routes/chat";
import { registerRealtimeVoiceRoutes } from "../routes/realtime-voice";
import { registerReviewRoutes } from "../routes/reviews";
import { registerSearchRoutes } from "../routes/search";
import { startResearchScheduler } from "../research-scheduler";
import { registerStateRoutes } from "../routes/state";
import { registerSystemRoutes } from "../routes/system";


export function registerErrorHandler(server: ReturnType<typeof Fastify>) {
  server.setErrorHandler((error: Error & { statusCode?: number }, request: FastifyRequest, reply: FastifyReply) => {
    // R3(M2):CAS 命令重试耗尽 → StateRevisionConflictError 冒到这里,映射成 409 如实告知冲突。
    // 此映射集中在全局 handler,runStateCommand 不再 per-throw 打 statusCode。全局 handler 只兜"未捕获
    // 错误";PUT /api/state 手动预检 revision + replaceState 不传 expectedRevision,永不抛该类、永不经此。
    // (GovernanceInFlightError 走下方 statusCode=409 分支,已自带 statusCode,无需在此列举。)
    if (error instanceof StateRevisionConflictError) {
      return reply.code(409).send({ error: error.message });
    }
    const statusCode = typeof error.statusCode === "number" ? error.statusCode : 500;
    if (statusCode >= 400 && statusCode < 500) {
      return reply.code(statusCode).send({ error: error.message });
    }
    console.error(
      JSON.stringify({
        event: "unhandled_server_error",
        method: request.method,
        url: request.url,
        error: error instanceof Error ? error.message : String(error)
      })
    );
    return reply.code(500).send({ error: "Internal Server Error" });
  });
}

export function registerCors(server: ReturnType<typeof Fastify>, env: Record<string, string | undefined>) {
  // Build the allowed origins set. PRODUCT_WEB_ORIGINS is a comma-separated list
  // of production origins (e.g. "https://app.example.com"). When absent, fall back
  // to the Vite dev-server origins so local development stays zero-friction.
  const extraOrigins = env.PRODUCT_WEB_ORIGINS
    ? new Set(env.PRODUCT_WEB_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean))
    : null;

  const devOrigins = new Set(["http://127.0.0.1:3220", "http://localhost:3220"]);

  server.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    const origin = request.headers.origin;

    let allowedOrigin: string | undefined;
    if (origin) {
      const allowedSet = extraOrigins ?? devOrigins;
      if (allowedSet.has(origin)) {
        allowedOrigin = origin;
      } else if (!extraOrigins) {
        // No PRODUCT_WEB_ORIGINS configured — keep old fallback for dev
        allowedOrigin = "http://127.0.0.1:3220";
      }
    }

    if (allowedOrigin) {
      // Reflect a specific origin (never *): required when Allow-Credentials is true so
      // split-origin SPA (vite:3220 → api:3210) can send HttpOnly bootstrap cookies.
      reply.header("access-control-allow-origin", allowedOrigin);
      reply.header("access-control-allow-credentials", "true");
      reply.header("vary", "Origin");
    }
    // 审计修复(P1-1 CSRF 面):浏览器跨站"简单请求"(无预检 POST)不受 CORS 拦【发送】——
    // dev/无 token 档下任意网页可盲发 POST /api/state/reset 清库(purge/import 有 confirm
    // 护栏,reset 无)。凡 mutating 请求携带 Origin 且既不在允许集也非同宿主,一律 403;
    // 无 Origin 的请求(curl/测试/服务端互调)不受影响,合法前端(允许集内)不受影响。
    if (origin && MUTATING_METHODS.has(request.method)) {
      const sameHost = origin === `${request.protocol}://${request.headers.host}`;
      const allowedSet = extraOrigins ?? devOrigins;
      if (!allowedSet.has(origin) && !sameHost) {
        return reply.code(403).send({ error: "Cross-origin mutating request rejected." });
      }
    }
    reply.header("access-control-allow-methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    // authorization for optional VITE/Bearer override; cookie is sent automatically when
    // Access-Control-Allow-Credentials is true (no Cookie request header preflight needed).
    reply.header("access-control-allow-headers", "content-type,authorization");
    reply.header("access-control-max-age", "86400");

    if (request.method === "OPTIONS") {
      return reply.code(204).send();
    }
  });
}

/**
 * P0-A: hard-fail a production launch that has no API token. The auth guard is a no-op
 * without a token, so starting production this way would expose every /api/* route
 * unauthenticated. Throwing here (only from startServer) refuses the launch with an
 * actionable message instead of silently booting an open instance.
 */
