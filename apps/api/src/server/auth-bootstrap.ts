/** Split from server.ts — keep constants co-located with registrars. */
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


export function assertProductionAuthConfigured(env: Record<string, string | undefined>) {
  const isProduction = (env.DEPLOYMENT_PROFILE ?? "").trim().toLowerCase() === "production";
  if (!isProduction) return;
  // Prefer human session auth; machine token still recommended for LiveKit agent.
  if (isSessionAuthEnabled(env)) {
    if (!(env.PRODUCT_SESSION_SECRET ?? "").trim()) {
      throw new Error(
        "生产部署已启用 PRODUCT_AUTH_ENABLED，必须配置 PRODUCT_SESSION_SECRET（会话 Cookie 签名密钥）。"
      );
    }
    return;
  }
  if (!env.PRODUCT_API_TOKEN) {
    throw new Error(
      "生产部署 (DEPLOYMENT_PROFILE=production) 必须配置 PRODUCT_API_TOKEN 或 PRODUCT_AUTH_ENABLED+PRODUCT_SESSION_SECRET：缺少凭证时鉴权守卫不会生效。"
    );
  }
}

// Paths exempted from auth when guard is active.
export const AUTH_EXEMPT_PREFIXES = [
  "/api/health",
  "/api/runtime-bootstrap",
  "/api/auth/login",
  "/api/auth/logout"
];

/**
 * Runtime bootstrap (S17):
 * - Session auth (PRODUCT_AUTH_ENABLED): report session presence; NEVER set PRODUCT_API_TOKEN cookie.
 * - Machine-token production: NEVER Set-Cookie long-lived PRODUCT_API_TOKEN by default.
 *   SPA should use VITE_PRODUCT_API_TOKEN (matrix B) or human session login.
 * - Emergency only: PRODUCT_BOOTSTRAP_LEGACY_TOKEN_COOKIE=1 restores old HttpOnly cookie (logs error).
 * Long-lived secrets never appear in free JSON body.
 */
export function registerRuntimeBootstrap(server: ReturnType<typeof Fastify>, env: Record<string, string | undefined>) {
  server.get("/api/runtime-bootstrap", async (request: FastifyRequest, reply: FastifyReply) => {
    if (!isAuthGuardActive(env)) {
      return { authRequired: false, cookieSet: false };
    }

    const principal = resolvePrincipal(env, {
      authHeader: typeof request.headers.authorization === "string" ? request.headers.authorization : undefined,
      cookieHeader: typeof request.headers.cookie === "string" ? request.headers.cookie : undefined
    });

    // L1 human session path
    if (isSessionAuthEnabled(env)) {
      if (principal?.kind === "user") {
        return {
          authRequired: true,
          authenticated: true,
          username: principal.username,
          cookieSet: true,
          mode: "session"
        };
      }
      return { authRequired: true, authenticated: false, cookieSet: false, mode: "session" };
    }

    // Machine-token only (production + PRODUCT_API_TOKEN, no session auth).
    if (!env.PRODUCT_API_TOKEN) {
      return { authRequired: false, cookieSet: false };
    }

    const legacyCookieRaw = (env.PRODUCT_BOOTSTRAP_LEGACY_TOKEN_COOKIE ?? "").trim().toLowerCase();
    const legacyCookieEnabled =
      legacyCookieRaw === "1" || legacyCookieRaw === "true" || legacyCookieRaw === "yes" || legacyCookieRaw === "on";

    // Emergency rollback only — do not enable in normal deploys.
    if (legacyCookieEnabled) {
      console.error(
        JSON.stringify({
          event: "bootstrap_legacy_token_cookie",
          level: "error",
          message:
            "PRODUCT_BOOTSTRAP_LEGACY_TOKEN_COOKIE is enabled: runtime-bootstrap is Set-Cookie'ing long-lived PRODUCT_API_TOKEN. Disable this flag; prefer PRODUCT_AUTH_ENABLED session login or VITE_PRODUCT_API_TOKEN (matrix B)."
        })
      );
      const token = env.PRODUCT_API_TOKEN;
      const secure = request.protocol === "https";
      reply.header(
        "Set-Cookie",
        `product_api_token=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`
      );
      return {
        authRequired: true,
        cookieSet: true,
        secureCookie: secure,
        mode: "machine_token",
        need_machine_token: false,
        legacyTokenCookie: true
      };
    }

    // Default (S17): never mint product_api_token cookie. Client may already hold a legacy cookie
    // from an older deploy — report presence without refreshing/re-issuing the secret.
    const existingCookie = readCookieToken(
      typeof request.headers.cookie === "string" ? request.headers.cookie : undefined
    );
    const alreadyHasLegacyCookie = Boolean(existingCookie && principal?.kind === "machine");

    return {
      authRequired: true,
      authenticated: alreadyHasLegacyCookie,
      cookieSet: alreadyHasLegacyCookie,
      mode: "machine_token",
      // SPA: use VITE_PRODUCT_API_TOKEN Bearer (matrix B) or enable session auth — not bootstrap cookie.
      need_machine_token: !alreadyHasLegacyCookie
    };
  });
}

export function registerAuthRoutes(server: ReturnType<typeof Fastify>, env: Record<string, string | undefined>) {
  ensureBootstrapUsers(env);

  server.post("/api/auth/login", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body ?? {}) as { username?: string; password?: string };
    const username = String(body.username ?? "").trim();
    const password = String(body.password ?? "");
    if (!username || !password) {
      return reply.code(400).send({ error: "username and password required" });
    }
    if (!authenticateUser(username, password, env)) {
      return reply.code(401).send({ error: "invalid credentials" });
    }
    if (isSessionAuthEnabled(env) && !(env.PRODUCT_SESSION_SECRET ?? "").trim()) {
      return reply.code(503).send({ error: "PRODUCT_SESSION_SECRET not configured" });
    }
    // Issue session even when only machine guard was historically used but bootstrap users exist.
    const secretOk = (env.PRODUCT_SESSION_SECRET ?? "").trim();
    if (!secretOk) {
      return reply.code(503).send({ error: "PRODUCT_SESSION_SECRET not configured" });
    }
    const token = issueSessionToken(username, { env });
    const secure =
      (env.PRODUCT_SESSION_SECURE ?? "").trim() === "1" ||
      request.protocol === "https";
    reply.header("Set-Cookie", sessionCookieHeader(token, { secure }));
    enterPrincipal({ kind: "user", username });
    return { ok: true, username };
  });

  server.post("/api/auth/logout", async (request: FastifyRequest, reply: FastifyReply) => {
    const secure =
      (env.PRODUCT_SESSION_SECURE ?? "").trim() === "1" || request.protocol === "https";
    reply.header("Set-Cookie", sessionCookieHeader("", { clear: true, secure }));
    enterPrincipal(null);
    return { ok: true };
  });

  server.get("/api/auth/me", async (request: FastifyRequest, reply: FastifyReply) => {
    const principal = resolvePrincipal(env, {
      authHeader: typeof request.headers.authorization === "string" ? request.headers.authorization : undefined,
      cookieHeader: typeof request.headers.cookie === "string" ? request.headers.cookie : undefined
    });
    if (!principal || principal.kind !== "user") {
      return reply.code(401).send({ error: "authentication required" });
    }
    return { username: principal.username };
  });
}

/** Wave A · A1.4: sliding-window limits on expensive / destructive API surfaces. */
export function registerSensitiveRouteRateLimit(server: ReturnType<typeof Fastify>, env: Record<string, string | undefined>) {
  const disabled = (env.RATE_LIMIT_DISABLED ?? "").trim().toLowerCase();
  // Vitest injects many rapid requests; default off under VITEST unless explicitly enabled.
  if (disabled === "1" || disabled === "true" || disabled === "yes") return;
  if (disabled !== "0" && disabled !== "false" && process.env.VITEST) return;

  const windowMs = Math.max(1_000, Number(env.RATE_LIMIT_WINDOW_MS) || 60_000);
  const defaultMax = Math.max(1, Number(env.RATE_LIMIT_MAX) || 60);
  const limiter = createRateLimiter({ max: defaultMax, windowMs });

  // Path prefix → optional stricter max (falls back to defaultMax via same limiter window;
  // we emulate stricter caps by requiring more "virtual" budget via separate limiter instances).
  const strict = createRateLimiter({
    max: Math.max(1, Number(env.RATE_LIMIT_STRICT_MAX) || 20),
    windowMs
  });

  const STRICT_PREFIXES = [
    "/api/auth/login",
    "/api/state/export",
    "/api/state/purge",
    "/api/state/import",
    "/api/state/reset",
    "/api/chat",
    "/api/rag/query",
    "/api/corpus/transcriptions",
    "/api/corpus/audio-files",
    "/api/realtime-voice"
  ];

  server.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    const path = request.url.split("?")[0] ?? "";
    if (!path.startsWith("/api/")) return;
    if (
      path === "/api/health" ||
      path.startsWith("/api/health/") ||
      path === "/api/runtime-bootstrap" ||
      path === "/api/auth/logout" ||
      path === "/api/auth/me"
    ) {
      return;
    }

    const useStrict = STRICT_PREFIXES.some((p) => path === p || path.startsWith(p + "/") || path.startsWith(p));
    // Only rate-limit mutating methods on general API; always limit strict prefixes (incl. GET export).
    if (!useStrict && request.method === "GET") return;

    const ip = request.ip || "unknown";
    const bucket = rateLimitBucket(useStrict ? `strict:${path}` : `api:${request.method}`, ip);
    const result = (useStrict ? strict : limiter).take(bucket);
    if (!result.allowed) {
      const retrySec = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
      reply.header("retry-after", String(retrySec));
      console.warn(JSON.stringify({
        event: "rate_limit_exceeded",
        path,
        method: request.method,
        ip,
        retryAfterSec: retrySec
      }));
      return reply.code(429).send({ error: `请求过于频繁，请 ${retrySec} 秒后重试。` });
    }
  });
}

export function registerProductionAuth(server: ReturnType<typeof Fastify>, env: Record<string, string | undefined>) {
  // Auth guard: session and/or production machine token — keeps pure local dev open when neither set.
  if (!isAuthGuardActive(env)) {
    return;
  }

  server.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    const path = (request.url.split("?")[0] ?? "").replace(/\/+$/, "") || "/";

    if (AUTH_EXEMPT_PREFIXES.some((prefix) => path === prefix || path.startsWith(prefix + "/"))) {
      return;
    }

    if (!path.startsWith("/api/")) {
      return;
    }

    // me is public shape but returns 401 without session — still needs principal binding attempt
    const tokenQuery = new URLSearchParams(request.url.split("?")[1] ?? "").get("token") ?? undefined;
    const cookieHeader = typeof request.headers.cookie === "string" ? request.headers.cookie : undefined;
    const cookieToken = readCookieToken(cookieHeader);
    const principal = bindRequestPrincipal(env, {
      authHeader: typeof request.headers.authorization === "string" ? request.headers.authorization : undefined,
      tokenQuery: tokenQuery ?? undefined,
      cookieHeader
    });

    if (path === "/api/auth/me") {
      return; // handler returns 401 if no user session
    }

    if (
      principal ||
      isAuthorized(env, {
        authHeader: typeof request.headers.authorization === "string" ? request.headers.authorization : undefined,
        tokenQuery: tokenQuery ?? undefined,
        cookieToken,
        cookieHeader
      })
    ) {
      return;
    }

    return reply.code(401).send({ error: "Unauthorized" });
  });
}

// R7:默认工厂只构造内存仓库。持久化(surreal 热态 + 三冷层)需异步连接,无法在同步的 buildApiServer
// 装配期建立,只能由 startServer 经 createSurrealStores 打开共享连接后注入。故这四个默认工厂不再看
// dbPath——真实 dbPath 也不落盘,持久化一律走 surreal 档的显式注入路径。
/**
 * Paths that should receive SPA index.html on unknown GET (client-side routes).
 * Asset URLs (.js/.wasm/.onnx/…) must 404 as plain text so browsers don't try to
 * execute HTML as an AudioWorklet module.
 */
