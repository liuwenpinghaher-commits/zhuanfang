// OpenTelemetry must be initialized before any other imports.
// N-10:具名导入 shutdownTelemetry——模块体的 sdk.start() 仍作为副作用在此(首位)执行,
// instrumentation 补丁照旧先于 fastify/http 加载;telemetry 不再自注册 SIGTERM,其 OTel 关闭
// 由下方 startServer 的统一优雅关闭序列在【数据 flush 之后】调用(见 createGracefulShutdown)。
import { shutdownTelemetry } from "./telemetry";

import Fastify, { type FastifyRequest, type FastifyReply } from "fastify";
import fastifyStatic from "@fastify/static";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
// R7:sqlite 冷层与 dual-write/dual-surreal 已删除;持久化唯一走 surreal(startServer 经
// createSurrealStores 注入),buildApiServer 默认工厂只构造内存仓库。
import { loadLocalEnvFile } from "./env";
import { resolveProductStoreSelection, type ProductStoreMode } from "./store-selection";
import { createInMemoryProductStateRepository, StateRevisionConflictError, type ProductStateRepository } from "./product-state-repository";
import { createInMemoryRawMaterialRepository, type RawMaterialRepository } from "./raw-material-repository";
import { createInMemoryAudioRepository, type AudioRepository } from "./audio-repository";
import { createInMemoryKnowledgeIndexRepository, type KnowledgeIndexRepository } from "./knowledge-index-repository";
import { createAnySearchClientFromEnv, type AnySearchClient } from "./providers/anysearch";
import { createLocalEmbeddingClient } from "./providers/local-embedding";
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
} from "./providers/bailian";
import {
  createBailianStreamingTtsClient,
  type BailianStreamingTtsClient,
  type BailianStreamingTtsOptions
} from "./providers/bailian-streaming-tts";
import {
  bindRequestPrincipal,
  isAuthGuardActive,
  isAuthorized,
  isSessionAuthEnabled,
  readCookieToken,
  resolvePrincipal,
  SESSION_COOKIE
} from "./auth";
import { authenticateUser, ensureBootstrapUsers } from "./auth/users";
import { issueSessionToken, sessionCookieHeader } from "./auth/session";
import { currentPrincipal, currentUsername, enterPrincipal, legacyOwner, sanitizeUserKey } from "./auth/user-context";
import {
  createInMemoryUserRepoFactory,
  createRegistryUserScopedProductStateRepository,
  createUserScopedProductStateRepository
} from "./auth/user-scoped-repository";
import { createUserScopedColdRepos } from "./auth/user-scoped-cold";
import {
  assertDurableUserScopedOrThrow,
  baseDataDirFromProductStateDbPath,
  createUserStoresRegistry,
  isUserScopedStateEnabled,
  resolveStoreUserKey,
  userStoreLruMax,
  type UserStoresRegistry
} from "./auth/user-stores-registry";
import { createLlmBudget } from "./llm-budget";
import { createRateLimiter, rateLimitBucket } from "./rate-limit";
import { resolveRequestTimeoutMs } from "./request-timeout";
import { resolveBailianApiKey } from "./runtime-secrets";
import { registerAssetRoutes } from "./routes/assets";
import { registerCorpusRoutes } from "./routes/corpus";
import { registerHealthRoutes } from "./routes/health";
import { registerImportRoutes } from "./routes/import";
import { registerInterviewSessionRoutes } from "./routes/interview-sessions";
import { registerKnowledgeRoutes, reindexOnStateChange } from "./routes/knowledge";
import { registerRawMaterialRoutes } from "./routes/raw-material";
import { registerAudioRoutes } from "./routes/audio";
import { registerMemoryRecordRoutes } from "./routes/memory-records";
import { registerMemoryCandidateRoutes } from "./routes/memory-candidates";
import { registerPlaybookPatchRoutes } from "./routes/playbook-patches";
import { registerPodcastRoutes } from "./routes/podcast";
import { registerRagRoutes } from "./routes/rag";
import { registerChatRoutes } from "./routes/chat";
import { registerRealtimeVoiceRoutes } from "./routes/realtime-voice";
import { registerReviewRoutes } from "./routes/reviews";
import { registerSearchRoutes } from "./routes/search";
import { startResearchScheduler } from "./research-scheduler";
import { registerStateRoutes } from "./routes/state";
import { registerSystemRoutes } from "./routes/system";

import {
  WRITE_SLOT_MAX_HOLD_MS,
  END_WRITE_PHASE_BUDGET_MS,
  type WriteGate,
  isWriteGateExempt,
  registerWriteSerialization,
} from "./server/write-gate";
import {
  registerErrorHandler,
  registerCors,
} from "./server/http-plugins";
import {
  AUTH_EXEMPT_PREFIXES,
  assertProductionAuthConfigured,
  registerRuntimeBootstrap,
  registerAuthRoutes,
  registerSensitiveRouteRateLimit,
  registerProductionAuth,
} from "./server/auth-bootstrap";
import {
  isSpaHistoryPath,
  createDefaultProductStateRepository,
  createDefaultRawMaterialRepository,
  createDefaultKnowledgeIndexRepository,
  createDefaultAudioRepository,
  withDeadline,
} from "./server/defaults";
import {
  type GracefulShutdownDeps,
  createGracefulShutdown,
} from "./server/shutdown";

interface BuildApiServerOptions {
  productStateRepository?: ProductStateRepository;
  productStateDbPath?: string;
  rawMaterialRepository?: RawMaterialRepository;
  audioRepository?: AudioRepository;
  knowledgeIndexRepository?: KnowledgeIndexRepository;
  bailianSearchClient?: BailianSearchClient;
  anySearchClient?: AnySearchClient;
  bailianPodcastAudioClient?: BailianPodcastAudioClient;
  bailianInterviewClient?: BailianCharacterInterviewClient;
  bailianChatClient?: BailianChatClient;
  bailianRealtimeVoiceClient?: BailianRealtimeVoiceClient;
  bailianTranscriptionClient?: BailianAudioTranscriptionClient;
  streamingTtsClient?: BailianStreamingTtsClient;
  streamingTtsClientFactory?: (options: BailianStreamingTtsOptions) => BailianStreamingTtsClient;
  embeddingClient?: BailianEmbeddingClient;
  /** 测试/嵌入场景可覆盖；生产默认比底层百炼请求超时多 5 秒，用于清理与结构化响应。 */
  interviewTurnTimeoutMs?: number;
  env?: Record<string, string | undefined>;
  envFilePath?: string;
  /** When true, do not auto-wrap productStateRepository with multi-user scoping. */
  disableUserScopedState?: boolean;
  /**
   * PR-S3: durable per-user SurrealStores registry. When set with USER_SCOPED=1,
   * hot+cold facades route via registry (singleflight/pin/LRU). Production forbids
   * memory multi-user factory when scoped (KD16).
   */
  userStoresRegistry?: UserStoresRegistry;
  /**
   * Start the background research scheduler. Only the persistent process
   * (startServer) sets this; buildApiServer/tests leave it off so no timers leak.
   */
  enableResearchScheduler?: boolean;
  /**
   * 审计修复(F-02/A2):实际生效的产品状态档位(resolveProductStoreSelection 的 mode),由
   * startServer 传入并透出到 /api/system/capabilities,让 E2E globalSetup 能验证测试没连上
   * 真实存储。R7:档位仅 memory|surreal 两档;不传时 stateStore 按内存如实上报——buildApiServer
   * 的默认工厂只构造内存仓库,持久化(surreal)只能由 startServer 显式注入并声明 productStoreMode。
   */
  productStoreMode?: ProductStoreMode;
}

interface ProviderClients {
  bailianSearchClient?: BailianSearchClient;
  anySearchClient?: AnySearchClient;
  bailianPodcastAudioClient?: BailianPodcastAudioClient;
  bailianInterviewClient?: BailianCharacterInterviewClient;
  bailianChatClient?: BailianChatClient;
  bailianRealtimeVoiceClient?: BailianRealtimeVoiceClient;
  voiceEnrollmentClient?: BailianVoiceEnrollmentClient;
  bailianTranscriptionClient?: BailianAudioTranscriptionClient;
  streamingTtsClient?: BailianStreamingTtsClient;
  embeddingClient?: BailianEmbeddingClient;
}

// 28 MB request body cap. Local audio uploads for corpus transcription are base64
// (~33% larger than raw) with a 25 MB base64 product cap, plus JSON overhead — this
// keeps the route-level 25 MB guard (which returns an actionable 422) the meaningful
// boundary, rather than Fastify's default 1 MB limit rejecting with a terse 413.
const REQUEST_BODY_LIMIT_BYTES = 28 * 1024 * 1024;

export function buildApiServer(options: BuildApiServerOptions = {}) {
  // 回归审查 R3-C:trustProxy 让 request.protocol 认 X-Forwarded-Proto——否则 TLS 终止反代下
  // request.protocol 恒 http,CSRF 守卫的 sameHost 比较(origin https:// vs http://internal)恒 false,
  // 漏配 PRODUCT_WEB_ORIGINS + 同源托管时会 403 拦掉全部合法同源写。
  const server = Fastify({ logger: false, bodyLimit: REQUEST_BODY_LIMIT_BYTES, trustProxy: true });
  const runtimeEnv = options.env ?? process.env;
  registerCors(server, runtimeEnv);
  registerProductionAuth(server, runtimeEnv);
  registerRuntimeBootstrap(server, runtimeEnv);
  registerAuthRoutes(server, runtimeEnv);
  registerSensitiveRouteRateLimit(server, runtimeEnv);
  const writeGate = registerWriteSerialization(server);
  registerErrorHandler(server);
  // R7:默认工厂只构造内存仓库(surreal 需异步连接,只能由 startServer 经 createSurrealStores 注入)。
  // P0 默认：所有登录用户共享同一 ProductState（与今日一致）。
  // P1/PR-S3 多用户分仓：PRODUCT_USER_SCOPED_STATE=1 时包装。
  // - durable: startServer 注入 userStoresRegistry → 热+三冷 facade + pin hook
  // - non-prod 无 registry: 内存 map 工厂（仅测试/本地）
  // - production 无 registry: KD16 拒绝启动
  // 测试可注入已 scoped 的 productStateRepository，并设 disableUserScopedState 避免二次包装。
  let baseRepo = options.productStateRepository ?? createDefaultProductStateRepository();
  const userStoresRegistry = options.userStoresRegistry;
  const userScoped =
    !options.disableUserScopedState &&
    isSessionAuthEnabled(runtimeEnv) &&
    isUserScopedStateEnabled(runtimeEnv);

  // KD16: production + USER_SCOPED=1 requires durable registry (not in-memory multi-tenant).
  if (userScoped) {
    assertDurableUserScopedOrThrow(runtimeEnv, {
      durable: Boolean(userStoresRegistry),
      productStoreMode: options.productStoreMode ?? (userStoresRegistry ? "surreal" : "memory")
    });
  }

  let rawMaterialRepository =
    options.rawMaterialRepository ?? createDefaultRawMaterialRepository();
  let audioRepository = options.audioRepository ?? createDefaultAudioRepository();
  let knowledgeIndexRepository =
    options.knowledgeIndexRepository ?? createDefaultKnowledgeIndexRepository();

  if (userScoped && userStoresRegistry) {
    // Durable full-store path: facades route by current principal (machine → legacy).
    const legacy = legacyOwner(runtimeEnv);
    baseRepo = createRegistryUserScopedProductStateRepository({
      registry: userStoresRegistry,
      env: runtimeEnv,
      fallbackUsername: legacy
    });
    const cold = createUserScopedColdRepos({
      registry: userStoresRegistry,
      env: runtimeEnv,
      fallbackUsername: legacy
    });
    rawMaterialRepository = cold.rawMaterialRepository;
    audioRepository = cold.audioRepository;
    knowledgeIndexRepository = cold.knowledgeIndexRepository;

    // Request pin: acquire/open user store before handlers; release after response.
    // Exempt auth/health bootstrap paths (no product data).
    type ReqWithStore = FastifyRequest & { _userStoreKey?: string };
    server.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
      if (reply.sent) return;
      const path = (request.url.split("?")[0] ?? "").replace(/\/+$/, "") || "/";
      if (!path.startsWith("/api/")) return;
      if (AUTH_EXEMPT_PREFIXES.some((prefix) => path === prefix || path.startsWith(prefix + "/"))) {
        return;
      }
      if (path === "/api/auth/me") return;

      // Auth hook already 401'd — do not open a store for anonymous callers.
      if (isAuthGuardActive(runtimeEnv) && !currentPrincipal()) return;

      // bindRequestPrincipal (registerProductionAuth) runs in an earlier onRequest hook.
      // Machine → legacy store (KD18); user → sanitize(username); null → fallback legacy.
      const storeKey = resolveStoreUserKey(runtimeEnv);
      try {
        await userStoresRegistry.acquire(storeKey);
        (request as ReqWithStore)._userStoreKey = storeKey;
      } catch (error) {
        console.error(JSON.stringify({
          event: "user_store_acquire_failed",
          userKey: storeKey,
          error: error instanceof Error ? error.message : String(error)
        }));
        return reply.code(503).send({
          error: "user store unavailable",
          detail: error instanceof Error ? error.message : String(error)
        });
      }
    });
    server.addHook("onResponse", async (request: FastifyRequest) => {
      const storeKey = (request as ReqWithStore)._userStoreKey;
      if (storeKey) userStoresRegistry.release(storeKey);
    });
  } else if (userScoped) {
    // Non-production memory multi-user factory (tests / local only; KD16 blocks production).
    const factory = createInMemoryUserRepoFactory();
    const legacy = legacyOwner(runtimeEnv);
    const map = new Map<string, ProductStateRepository>();
    map.set(sanitizeUserKey(legacy), baseRepo);
    baseRepo = createUserScopedProductStateRepository({
      env: runtimeEnv,
      fallbackUsername: legacy,
      getOrCreate(username: string) {
        const key = sanitizeUserKey(username);
        let r = map.get(key);
        if (!r) {
          r = factory.getOrCreate(username);
          map.set(key, r);
        }
        return r;
      }
    });
  }
  const innerProductStateRepository = baseRepo;
  const providerClients: ProviderClients = {};
  const refreshProviderClients = () => refreshRuntimeProviderClients(providerClients, runtimeEnv, options);
  refreshProviderClients();
  const withLiveProviderClients = <T extends object>(extra: T): T & ProviderClients => {
    const target = { ...extra } as T & ProviderClients;
    Object.defineProperties(target, {
      bailianSearchClient: { enumerable: true, get: () => providerClients.bailianSearchClient },
      anySearchClient: { enumerable: true, get: () => providerClients.anySearchClient },
      bailianPodcastAudioClient: { enumerable: true, get: () => providerClients.bailianPodcastAudioClient },
      bailianInterviewClient: { enumerable: true, get: () => providerClients.bailianInterviewClient },
      bailianChatClient: { enumerable: true, get: () => providerClients.bailianChatClient },
      bailianRealtimeVoiceClient: { enumerable: true, get: () => providerClients.bailianRealtimeVoiceClient },
      voiceEnrollmentClient: { enumerable: true, get: () => providerClients.voiceEnrollmentClient },
      bailianTranscriptionClient: { enumerable: true, get: () => providerClients.bailianTranscriptionClient },
      streamingTtsClient: { enumerable: true, get: () => providerClients.streamingTtsClient },
      embeddingClient: { enumerable: true, get: () => providerClients.embeddingClient }
    });
    return target;
  };
  // R7:持久化只由 surreal 档提供(唯一持久档,startServer 经 createSurrealStores 注入并显式传入
  // productStoreMode="surreal")。buildApiServer 的默认工厂只构造内存仓库,故未显式声明 surreal 档时
  // 一律按内存如实上报——不再据 dbPath 猜测(默认工厂已不会因真实 dbPath 落盘)。
  const stateStore: "memory" | "surreal" = options.productStoreMode === "surreal" ? "surreal" : "memory";

  const isProductionProfile = (runtimeEnv.DEPLOYMENT_PROFILE ?? "").trim().toLowerCase() === "production";
  // Fail-LOUD 而非 fail-open-silent:startServer() 在生产缺 token 时硬抛拒绝启动(生产硬闸);但直接用
  // buildApiServer 的嵌入/脚本路径若在生产 profile 缺 token,鉴权守卫静默关闭、全 /api/* 裸奔。这里至少
  // 响亮告警,不再静默。(嵌入方可自带鉴权层,故告警而非抛错,避免破坏合法用法。)
  if (isProductionProfile && !runtimeEnv.PRODUCT_API_TOKEN && !isSessionAuthEnabled(runtimeEnv)) {
    console.warn(JSON.stringify({
      event: "auth_guard_inactive_in_production",
      detail: "DEPLOYMENT_PROFILE=production 但未设 PRODUCT_API_TOKEN / PRODUCT_AUTH_ENABLED —— 鉴权守卫未启用。"
    }));
  }
  // 生产 profile 却回落内存存储(通常是 PRODUCT_STORE=memory 或漏配 surreal 档) → 进程重启全部数据丢失。响亮告警。
  if (isProductionProfile && stateStore === "memory") {
    console.warn(JSON.stringify({
      event: "state_store_in_memory_in_production",
      detail: "生产 profile 使用内存状态存储(PRODUCT_STORE=memory 或 dbPath 为 :memory:) —— 进程重启将丢失全部数据。持久化请设 PRODUCT_STORE=surreal。"
    }));
  }
  // R7:三冷层默认内存;surreal 档由 startServer 注入。PR-S3 durable scoped 时上面已换成 registry facade。
  const envFilePath = options.envFilePath ?? join(process.cwd(), ".env.local");

  // Single shared budget instance — covers all LLM entry points (interview turns,
  // pre-signals, corpus insights, reviews, import, search enrichment, podcast script).
  // Uses "system" key for non-session endpoints and session.id for session endpoints.
  const sharedBudget = createLlmBudget();

  // 持久化边界增量索引：包住 product-state 仓库，每次 replaceState 后 fire-and-forget 触发
  // 增量重索引。PR-S3：在 replaceState 同步路径 resolve 当前用户的 concrete knowledge（ALS+pin 仍有效），
  // 避免 fire-and-forget 时 facade 回落 legacy（KD6）。
  const knowledgeForReindex: KnowledgeIndexRepository | (() => KnowledgeIndexRepository) =
    userStoresRegistry
      ? () => {
          const key = resolveStoreUserKey(runtimeEnv);
          return userStoresRegistry.requireReady(key).knowledgeIndex;
        }
      : knowledgeIndexRepository;
  const productStateRepository = withKnowledgeReindex(
    innerProductStateRepository,
    knowledgeForReindex,
    () => providerClients.embeddingClient,
    sharedBudget
  );

  // E:surreal 权威库落库健康度探针 → /api/health 暴露 persist.degraded。
  // PR-S3 flag=1: 聚合 legacy + 当前已打开仓的 max(consecutiveFailures)(未打开用户仓不可见)。
  const probePersistHealth = () => {
    if (userStoresRegistry) {
      return userStoresRegistry.aggregatePersistHealth();
    }
    const repo = innerProductStateRepository as {
      getPersistHealth?: () => { consecutiveFailures: number; lastError?: string; lastErrorAt?: string };
    };
    return repo.getPersistHealth?.();
  };
  // 方案二:图↔软链一致性审计探针。R7:surreal 权威直接有 auditGraphConsistency;内存档 → undefined
  // → 路由回 501。方法是 handle 闭包实现、不依赖 this,解包后直调安全。
  type GraphAuditFn = () => Promise<{
    ok: boolean; auditedEdgeTables: string[]; expectedCount: number; actualCount: number;
    missingCount: number; unexpectedCount: number; missingInDb: string[]; unexpectedInDb: string[];
    danglingProvenanceCount: number;
    nodeMissingCount: number; nodeUnexpectedCount: number; nodeMissingInDb: string[]; nodeUnexpectedInDb: string[];
  }>;
  const probeGraphAudit = () => {
    const repo = innerProductStateRepository as {
      auditGraphConsistency?: GraphAuditFn;
    };
    const audit = repo.auditGraphConsistency;
    return audit?.();
  };
  void server.register(registerHealthRoutes(probePersistHealth, probeGraphAudit));
  void server.register(async (registeredServer) => {
    await registerSystemRoutes(registeredServer, productStateRepository, {
      stateStore,
      // 审计修复(P3-47→F-02/A2):真实权威库档位透出。只信 startServer 解析后传入的 mode,不读
      // env.PRODUCT_STORE——嵌入/测试路径下 buildApiServer 默认工厂只构造内存仓库,按 env 上报会在
      // sentinel 场景下撒谎。R7:档位仅 memory|surreal。未传时直传 undefined:`?? stateStore` 如实
      // 回落只归 system.ts 一处,避免双份兜底漂移。
      productStore: options.productStoreMode,
      env: runtimeEnv,
      envFilePath,
      refreshProviderClients,
      get bailianSearchClient() {
        return providerClients.bailianSearchClient;
      },
      get anySearchClient() {
        return providerClients.anySearchClient;
      },
      get bailianPodcastAudioClient() {
        return providerClients.bailianPodcastAudioClient;
      },
      get bailianInterviewClient() {
        return providerClients.bailianInterviewClient;
      },
      get bailianRealtimeVoiceClient() {
        return providerClients.bailianRealtimeVoiceClient;
      },
      get bailianTranscriptionClient() {
        return providerClients.bailianTranscriptionClient;
      }
    });
  });
  void server.register(async (registeredServer) => {
    await registerStateRoutes(registeredServer, productStateRepository, withLiveProviderClients({
      env: runtimeEnv,
      rawMaterialRepository,
      audioRepository,
      knowledgeIndexRepository,
      llmBudget: sharedBudget
    }));
  });
  void server.register(async (registeredServer) => {
    await registerInterviewSessionRoutes(registeredServer, productStateRepository, withLiveProviderClients({
      rawMaterialRepository,
      knowledgeIndexRepository,
      llmBudget: sharedBudget,
      writeGate,
      interviewTurnTimeoutMs:
        options.interviewTurnTimeoutMs ??
        resolveRequestTimeoutMs(runtimeEnv, "BAILIAN_INTERVIEW_REQUEST_TIMEOUT_MS") + 5_000
    }));
  });
  void server.register(async (registeredServer) => {
    await registerRawMaterialRoutes(registeredServer, rawMaterialRepository, productStateRepository);
  });
  void server.register(async (registeredServer) => {
    await registerAudioRoutes(registeredServer, audioRepository, productStateRepository);
  });
  void server.register(async (registeredServer) => {
    await registerSearchRoutes(registeredServer, productStateRepository, withLiveProviderClients({
      llmBudget: sharedBudget,
      writeGate
    }));
  });
  void server.register(async (registeredServer) => {
    await registerPodcastRoutes(registeredServer, productStateRepository, withLiveProviderClients({
      llmBudget: sharedBudget
    }));
  });
  void server.register(async (registeredServer) => {
    await registerRealtimeVoiceRoutes(registeredServer, withLiveProviderClients({
      stateRepo: productStateRepository,
      env: runtimeEnv,
      writeGate
    }));
  });
  void server.register(async (registeredServer) => {
    await registerCorpusRoutes(registeredServer, productStateRepository, withLiveProviderClients({
      llmBudget: sharedBudget,
      env: runtimeEnv
    }));
  });
  void server.register(async (registeredServer) => {
    await registerReviewRoutes(registeredServer, productStateRepository, withLiveProviderClients({
      llmBudget: sharedBudget
    }));
  });
  void server.register(async (registeredServer) => {
    await registerImportRoutes(registeredServer, productStateRepository, withLiveProviderClients({
      knowledgeIndexRepository,
      llmBudget: sharedBudget,
      writeGate
    }));
  });
  void server.register(async (registeredServer) => {
    await registerMemoryRecordRoutes(registeredServer, productStateRepository, withLiveProviderClients({
      // 审计修复(P2-12):编辑记忆文本重嵌所需(与 approve 同源 client)。
      // 回归审查 R6-6:PATCH 豁免全局写锁后,handler 用 writeGate 把同步 RMW 串行化(embed 在锁外)。
      writeGate
    }));
  });
  void server.register(async (registeredServer) => {
    // M3c: candidate approval embeds the new long-term record (semantic recall).
    // M5: consolidation (POST /api/memory/consolidate) reuses the chat client to
    // optionally summarize merged clusters into pending HITL candidates.
    await registerMemoryCandidateRoutes(registeredServer, productStateRepository, withLiveProviderClients({
      // 审计修复(P1-6):补上全库 13 个 LLM 调用点中唯一漏网的预算接线。
      llmBudget: sharedBudget,
      // R3:PATCH /:id 与 POST /:id/reject 已豁免全局写锁,CAS commit 经写门(approve/consolidate 仍持锁)。
      writeGate
    }));
  });
  void server.register(async (registeredServer) => {
    // R3:决策确认已豁免全局写锁,CAS commit 经写门。
    await registerAssetRoutes(registeredServer, productStateRepository, { writeGate });
  });
  void server.register(async (registeredServer) => {
    // R3:apply/revert 已豁免全局写锁,CAS commit 经写门。
    await registerPlaybookPatchRoutes(registeredServer, productStateRepository, { writeGate });
  });
  void server.register(async (registeredServer) => {
    await registerRagRoutes(registeredServer, productStateRepository, withLiveProviderClients({
      llmBudget: sharedBudget
    }));
  });
  void server.register(async (registeredServer) => {
    await registerKnowledgeRoutes(
      registeredServer,
      productStateRepository,
      rawMaterialRepository,
      knowledgeIndexRepository,
      withLiveProviderClients({
        llmBudget: sharedBudget,
        writeGate
      })
    );
  });
  void server.register(async (registeredServer) => {
    await registerChatRoutes(registeredServer, productStateRepository, knowledgeIndexRepository, withLiveProviderClients({
      llmBudget: sharedBudget,
      writeGate
    }));
  });

  // Static file serving: when PRODUCT_STATIC_DIR is set (production Docker image),
  // serve the built frontend from that directory. Registered after all API routes
  // so /api/* handlers take precedence.
  // "disabled" is an explicit opt-out (matches the README); any other value is a root dir.
  const staticDir = runtimeEnv.PRODUCT_STATIC_DIR;
  if (staticDir && staticDir !== "disabled") {
    void server.register(fastifyStatic, { root: staticDir });
    // SPA history fallback: serve index.html for non-/api GET routes so deep-link refresh
    // (e.g. /podcast) doesn't 404. /api/* still falls through to a JSON 404.
    // Do NOT fall back asset-like paths (esp. /vad/* worklet/onnx/wasm) to index.html —
    // AudioWorklet.addModule would then load HTML and throw AbortError.
    server.setNotFoundHandler((request, reply) => {
      if (request.method === "GET" && !request.url.startsWith("/api/")) {
        const pathOnly = request.url.split("?")[0] ?? request.url;
        if (isSpaHistoryPath(pathOnly)) {
          return reply.sendFile("index.html");
        }
        return reply.code(404).type("text/plain").send("Not found");
      }
      return reply.code(404).send({ error: "Not found" });
    });
  }

  // Background research scheduler — only in the persistent process (startServer sets
  // the flag). Started here so it shares the real provider clients + the same LLM
  // budget as the search routes. It self-gates per tick on systemConfig.research.
  if (options.enableResearchScheduler) {
    const research = productStateRepository.getState().systemConfig.research;
    startResearchScheduler({
      repository: productStateRepository,
      clients: providerClients, // live ref — picks up runtime key refreshes
      budget: sharedBudget,
      intervalMs: (research?.scheduleIntervalMin ?? 1440) * 60 * 1000,
      writeGate
    });
  }

  return server;
}

/**
 * 把 product-state 仓库包一层：每次 replaceState 后 fire-and-forget 触发增量重索引。
 *
 * - 先 inner.getState() 取写前快照（getState 返回深拷贝，安全）；
 * - 调 inner.replaceState 真正落库、拿到返回的新状态（也是深拷贝）；
 * - void reindexOnStateChange(...)：不 await、不阻塞写、不抛——reindex 自身已整体 try/catch。
 *
 * embeddingClient 通过 getter 取，因为运行时 refresh 会重建该 client（key 变更），
 * 装配期一次性捕获会拿到陈旧引用。
 *
 * knowledgeRepo 可为固定 repo，或 `() => KnowledgeIndexRepository`（PR-S3 分仓）：
 * getter 在 replaceState **同步路径**内解析（ALS principal 仍在），再交给 fire-and-forget，
 * 避免异步 reindex 时 ALS 已退出、facade 回落 legacy 写错用户 knowledge（KD6）。
 */
export function withKnowledgeReindex(
  inner: ProductStateRepository,
  knowledgeRepo: KnowledgeIndexRepository | (() => KnowledgeIndexRepository),
  getEmbeddingClient: () => BailianEmbeddingClient | undefined,
  budget: ReturnType<typeof createLlmBudget>
): ProductStateRepository {
  const resolveKnowledge = (): KnowledgeIndexRepository =>
    typeof knowledgeRepo === "function" ? knowledgeRepo() : knowledgeRepo;
  return {
    // 能力透传(P2b 生产可达性修复):此前只回 4 个接口方法,把 inner(surreal handle)的原生召回
    // /治理事务/审计能力全部吞掉 → 路由层 asNativeRecall(wrapped) 恒 undefined,原生召回在生产静默
    // 失效、fail-safe 回落把问题掩成"一切正常"。spread 透传 own 方法(repo 各实现均为闭包方法的对象
    // 字面量,不依赖 this,解包安全),使 surreal 档的原生能力(recall*/runGovernanceTransaction/
    // getPersistHealth/auditGraphConsistency)真正可达;后声明的同名键覆盖 spread,读写语义不变。
    ...inner,
    getState: () => inner.getState(),
    resetState: () => inner.resetState(),
    getInterviewSession: (id) => inner.getInterviewSession(id),
    replaceState(next, opts) {
      const prev = inner.getState();
      const result = inner.replaceState(next, opts);
      // fire-and-forget：reindex 用落库后的真实下一态(result)，而非传入的 next（revision 已由仓库 bump）。
      // 回归审查 R4-3:import/purge 传 skipReindex——它们随后显式全量 rebuild/清空,包装层的增量重索引
      // 是重复嵌入(与显式 rebuild 竞态,浪费预算)。跳过后由显式路径负责索引一致性。
      if (!opts?.skipReindex) {
        // Resolve knowledge under current ALS / pin, then hand a concrete repo to async reindex.
        const knowledgeForUser = resolveKnowledge();
        void reindexOnStateChange(prev, result, knowledgeForUser, getEmbeddingClient(), budget);
      }
      return result;
    }
  };
}

function refreshRuntimeProviderClients(
  providerClients: ProviderClients,
  env: Record<string, string | undefined>,
  options: BuildApiServerOptions
) {
  providerClients.bailianSearchClient = options.bailianSearchClient ?? createBailianSearchClientFromEnv(env);
  providerClients.anySearchClient = options.anySearchClient ?? createAnySearchClientFromEnv(env);
  providerClients.bailianPodcastAudioClient = options.bailianPodcastAudioClient ?? createBailianPodcastAudioClientFromEnv(env);
  providerClients.bailianInterviewClient = options.bailianInterviewClient ?? createBailianCharacterInterviewClientFromEnv(env);
  providerClients.bailianChatClient = options.bailianChatClient ?? createBailianChatClientFromEnv(env);
  providerClients.bailianRealtimeVoiceClient = options.bailianRealtimeVoiceClient ?? createBailianRealtimeVoiceClientFromEnv(env);
  providerClients.voiceEnrollmentClient = createBailianVoiceEnrollmentClientFromEnv(env);
  providerClients.bailianTranscriptionClient =
    options.bailianTranscriptionClient ?? createBailianAudioTranscriptionClientFromEnv(env);
  // Embedding client for RAG / semantic search. Returns null when no API key — routes
  // that need it should fall back to deterministic retrieval when null.
  // B2:EMBEDDING_PROVIDER=local → 本地 bge-large-zh(离线、不卡);否则云端 DashScope(默认,无 key→undefined)。
  providerClients.embeddingClient =
    options.embeddingClient ??
    ((env.EMBEDDING_PROVIDER ?? "").trim().toLowerCase() === "local"
      ? createLocalEmbeddingClient()
      : createBailianEmbeddingClientFromEnv(env) ?? undefined);
  // Streaming TTS client for the TTS WebSocket proxy (browser ↔ CosyVoice).
  // If no API key is configured, the proxy will reject upgrades with 4001 at
  // connect time — safe to leave undefined here.
  const ttsApiKey = resolveBailianApiKey(env);
  providerClients.streamingTtsClient =
    options.streamingTtsClient ??
    (ttsApiKey
      ? (options.streamingTtsClientFactory ?? createBailianStreamingTtsClient)({ apiKey: ttsApiKey })
      : undefined);
}
export async function startServer() {
  loadLocalEnvFile();

  // I 预热:本地 embedding(transformers.js)首次需加载/下载模型。启动期 await 预热完成再 listen,
  // 避免 create session 撞冷加载 + embed timeout → 502。失败不阻断启动(可后续首请求重试)。
  // 单例 extractorPromise 模块级,与路由层共享同一次加载。
  if ((process.env.EMBEDDING_PROVIDER ?? "").trim().toLowerCase() === "local") {
    const prewarmStarted = Date.now();
    try {
      await createLocalEmbeddingClient().embed(["预热"]);
      console.info(JSON.stringify({
        event: "local_embedding_prewarm_ok",
        ms: Date.now() - prewarmStarted
      }));
    } catch (error) {
      console.warn(JSON.stringify({
        event: "local_embedding_prewarm_failed",
        ms: Date.now() - prewarmStarted,
        error: error instanceof Error ? error.message : String(error)
      }));
    }
  }

  // P0-A fail-closed: in the production profile the bearer guard only activates when a
  // token is present (see isAuthGuardActive). Refuse to start a production deployment
  // without PRODUCT_API_TOKEN, otherwise every /api/* route (full privacy export, one-shot
  // purge, provider-config writes, WS voice proxies) would be reachable with no credential.
  // buildApiServer() stays token-free on purpose so tests can construct a server in-memory;
  // this guard lives here so it only bites when a real, listening process is launched.
  assertProductionAuthConfigured(process.env);

  // Persist by default so a server restart no longer drops all interview state.
  // Tests call buildApiServer() directly (no dbPath) and stay in-memory/isolated.
  // 审计修复(F-02/A2):档位与路径解析收敛到纯函数 resolveProductStoreSelection——
  // dbPath sentinel(memory/:memory:/in-memory)一律解析为 memory 档位并压过 PRODUCT_STORE,
  // 否则 E2E 只设 PRODUCT_STATE_DB_PATH=memory 时会继承 .env.local 的持久档位连上真实存储。
  // R7:档位已收敛为 memory|surreal 两档(sqlite/dual/dual-surreal 已删除,旧值归一到 surreal)。
  const selection = resolveProductStoreSelection(process.env);
  const { mode: productStore, productStateDbPath } = selection;

  // R7:命中已废弃档位值(sqlite/dual/dual-surreal)时响亮告警,让运维知道旧 .env 需改为 surreal
  // (已按 surreal 启动,不炸)。
  if (selection.deprecatedProductStore) {
    console.warn(JSON.stringify({
      event: "product_store_deprecated",
      deprecatedProductStore: selection.deprecatedProductStore,
      detail: selection.reason
    }));
  }

  // PR-S3: session auth + USER_SCOPED=1 → durable per-user SurrealStores (or KD16 refuse in production).
  const userScopedAtStart =
    isSessionAuthEnabled(process.env) && isUserScopedStateEnabled(process.env);

  // R2a:surreal 档下热态 + 三冷层共用同一嵌入式连接(嵌入式 surrealkv 同进程独占锁,不能开第二连接)。
  // createSurrealStores 打开一个连接、applySchema 一次,返回热态仓库 + 三冷层仓库。
  type LoadedSurrealStores = {
    productState: ProductStateRepository;
    rawMaterial: RawMaterialRepository;
    audio: AudioRepository;
    knowledgeIndex: KnowledgeIndexRepository;
    close: () => Promise<void>;
  };
  const loadSurrealModule = async () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    return (await (Function("p", "return import(p)") as (p: string) => Promise<{
      createSurrealStores: (opts: { url: string }) => Promise<LoadedSurrealStores>;
    }>)(new URL("../../../packages/db/src/surreal/surreal-cold-repositories.ts", import.meta.url).pathname));
  };
  const loadSurrealStoresAtUrl = async (url: string): Promise<LoadedSurrealStores> => {
    const mod = await loadSurrealModule();
    return mod.createSurrealStores({ url });
  };
  const loadLegacySurrealStores = async () => {
    const dataDir = join(dirname(productStateDbPath), "surreal");
    return loadSurrealStoresAtUrl(`surrealkv://${dataDir}/surreal`);
  };

  let repository: ProductStateRepository;
  // N-10:surreal 档的「flush persist 队列 + 关共享连接」句柄(优雅关闭时调);memory 档为 undefined。
  // PR-S3 scoped: storesClose = registry.closeAll().
  let storesClose: (() => Promise<void>) | undefined;
  let userStoresRegistry: UserStoresRegistry | undefined;
  // R7:档位收敛为 memory|surreal 两档。surreal 档注入 Surreal 冷层(与热态同连接);memory 档
  // 冷层 undefined → buildApiServer 走默认内存工厂。
  let surrealColdRepos: {
    rawMaterialRepository?: RawMaterialRepository;
    audioRepository?: AudioRepository;
    knowledgeIndexRepository?: KnowledgeIndexRepository;
  } = {};

  // KD16 hard gate before any listen: production + scoped + non-durable store → refuse.
  if (userScopedAtStart) {
    assertDurableUserScopedOrThrow(process.env, {
      durable: productStore === "surreal",
      productStoreMode: productStore
    });
  }

  if (productStore === "memory") {
    // F-02/A2:in-memory 档位(sentinel 或显式 PRODUCT_STORE=memory)。productStateDbPath 此时
    // 恒为 sentinel,buildApiServer 的冷层默认工厂(raw/audio/knowledge)同走内存,零落盘。
    // USER_SCOPED=1 仅允许非 production(已在 assert 放行)→ buildApiServer 内存分仓工厂。
    repository = createInMemoryProductStateRepository();
    console.warn(JSON.stringify({
      event: "product_store",
      mode: "memory",
      reason: selection.reason,
      userScoped: userScopedAtStart,
      // sentinel 压过档位继承时响亮注明,避免运维误以为持久档生效。
      ...(selection.ignoredProductStore ? { ignoredProductStore: selection.ignoredProductStore } : {})
    }));
  } else if (userScopedAtStart) {
    // PR-S3 durable path: pre-open legacy full stores; lazy-open other users via registry.
    const legacy = legacyOwner(process.env);
    const legacyKey = sanitizeUserKey(legacy);
    const baseDataDir = baseDataDirFromProductStateDbPath(productStateDbPath);
    let legacyStores: LoadedSurrealStores;
    try {
      legacyStores = await loadLegacySurrealStores();
    } catch (error) {
      const dataDir = join(dirname(productStateDbPath), "surreal");
      const timedOut = error instanceof Error && error.name === "SurrealConnectTimeoutError";
      console.error(JSON.stringify({
        event: "surreal_connect_failed",
        dataDir,
        userKey: legacyKey,
        suspectedCause: timedOut ? "另一进程可能正持有该数据目录的独占锁(双开)" : "连接/初始化失败",
        detail: error instanceof Error ? error.message : String(error)
      }));
      process.exit(1);
    }
    const registry = createUserStoresRegistry({
      baseDataDir,
      legacyUserKey: legacyKey,
      maxOpen: userStoreLruMax(process.env),
      openStores: async ({ url, userKey, dataDir }) => {
        try {
          return await loadSurrealStoresAtUrl(url);
        } catch (error) {
          const timedOut = error instanceof Error && error.name === "SurrealConnectTimeoutError";
          console.error(JSON.stringify({
            event: "surreal_connect_failed",
            dataDir,
            userKey,
            suspectedCause: timedOut ? "另一进程可能正持有该数据目录的独占锁(双开)" : "连接/初始化失败",
            detail: error instanceof Error ? error.message : String(error)
          }));
          throw error;
        }
      }
    });
    registry.seed(legacyKey, legacyStores);
    userStoresRegistry = registry;
    // Facades built inside buildApiServer from registry; seed productState only for type fallbacks.
    repository = legacyStores.productState;
    storesClose = () => registry.closeAll();
    console.warn(JSON.stringify({
      event: "product_store",
      mode: "surreal",
      reason: selection.reason,
      userScoped: true,
      detail: "PR-S3 durable UserStoresRegistry (legacy pre-open; lazy per-user full stores)"
    }));
  } else {
    // R7:surreal 是唯一持久档。flag=0 保持今日：一次 createSurrealStores → 注入。
    // N-07:嵌入式 surrealkv 同进程独占锁——若另一进程已持锁,connect 会静默永挂。
    let stores: LoadedSurrealStores;
    try {
      stores = await loadLegacySurrealStores();
    } catch (error) {
      const dataDir = join(dirname(productStateDbPath), "surreal");
      const timedOut = error instanceof Error && error.name === "SurrealConnectTimeoutError";
      console.error(JSON.stringify({
        event: "surreal_connect_failed",
        dataDir,
        suspectedCause: timedOut ? "另一进程可能正持有该数据目录的独占锁(双开)" : "连接/初始化失败",
        detail: error instanceof Error ? error.message : String(error)
      }));
      process.exit(1);
    }
    repository = stores.productState;
    storesClose = stores.close;   // N-10:优雅关闭时 flush persist 队列 + 关连接
    surrealColdRepos = {
      rawMaterialRepository: stores.rawMaterial,
      audioRepository: stores.audio,
      knowledgeIndexRepository: stores.knowledgeIndex,
    };
    console.warn(JSON.stringify({ event: "product_store", mode: "surreal", reason: selection.reason, detail: "热态+三冷层同连接(R2a)" }));
  }
  // F-02 事故收口(2026-07-10):Playwright 定向实跑中,navigation.spec 的陈旧 mock 未拦截,
  // PATCH /api/system/config 打到 webServer 起的真实 API——buildApiServer 默认 envFilePath 是
  // join(process.cwd(), ".env.local"),writeEnvFileUpdates 把仓库根 .env.local 里的真实
  // DASHSCOPE_API_KEY 覆盖成了测试占位值(已人工恢复)。mock 修好只是测试侧防线;产品级
  // 防线在这里:允许用 PRODUCT_ENV_FILE 把"运行时配置写盘路径"指到隔离文件,测试/托管环境
  // 的 config 写永远落不到仓库根 .env.local(playwright.config.ts 的 webServer env 已设)。
  const productEnvFile = (process.env.PRODUCT_ENV_FILE ?? "").trim();
  // enableResearchScheduler: only the persistent process runs the background scheduler.
  // It self-gates per tick on systemConfig.research.autoScheduleEnabled (default off),
  // so users can toggle it on at runtime without a restart.
  const server = buildApiServer({
    productStateRepository: repository,
    // R7:surreal 档注入 Surreal 冷层(与热态同连接);memory 档为空 → buildApiServer 走默认内存工厂。
    // PR-S3 durable scoped: cold facades come from registry inside buildApiServer (skip seed cold).
    ...(userStoresRegistry ? {} : surrealColdRepos),
    ...(userStoresRegistry ? { userStoresRegistry } : {}),
    // F-02/A2:把实际生效档位透出到 /api/system/capabilities,供 E2E globalSetup 校验隔离。
    productStoreMode: productStore,
    enableResearchScheduler: true,
    ...(productEnvFile ? { envFilePath: productEnvFile } : {})
  });
  const port = Number(process.env.PORT ?? 3210);
  const host = process.env.HOST ?? "127.0.0.1";
  await server.listen({ host, port });

  // N-10:优雅关闭钩子——SIGINT/SIGTERM 时先停收新请求、再排空 persist 队列(数据优先)、
  // 再关 OTel、最后退出。R7 删同步 sqlite 后 persist 是唯一持久路径,裸退会丢已确认 200 的写;
  // telemetry.ts 已不再自注册 SIGTERM(避免两个 handler 各自 exit 打架),OTel 关闭串进本序列。
  // 仅 startServer(真实常驻进程)注册钩子;buildApiServer/测试路径不注册,故不泄漏信号 handler。
  const flushPersistence = async () => {
    if (storesClose) {
      // surreal 档 / PR-S3 registry: close() flush persist 队列 + 关连接(们)。
      await storesClose();
    } else {
      // memory 档:flush 若存在则排空(基接口无 flush → no-op 也无妨),无连接可关 → 干净退出。
      await (repository as { flush?: () => Promise<void> }).flush?.();
    }
  };
  const gracefulShutdown = createGracefulShutdown({
    closeServer: () => server.close(),
    flushPersistence,
    shutdownTelemetry,
    exit: (code) => process.exit(code)
  });
  // process.once:同一信号只触发一次(自动摘除 handler);跨信号(SIGINT 后 SIGTERM)由
  // createGracefulShutdown 内部的 shuttingDown 幂等守卫兜住,二者叠加=双保险。
  process.once("SIGINT", () => void gracefulShutdown("SIGINT"));
  process.once("SIGTERM", () => void gracefulShutdown("SIGTERM"));

  return server;
}

export function isDirectCliExecution(importMetaUrl: string, argvEntry: string | undefined) {
  return Boolean(argvEntry) && importMetaUrl === pathToFileURL(argvEntry!).href;
}

if (isDirectCliExecution(import.meta.url, process.argv[1])) {
  startServer().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

export {
  WRITE_SLOT_MAX_HOLD_MS,
  END_WRITE_PHASE_BUDGET_MS,
  isWriteGateExempt,
  type WriteGate,
} from "./server/write-gate";
export { assertProductionAuthConfigured } from "./server/auth-bootstrap";
export { isSpaHistoryPath } from "./server/defaults";
export { createGracefulShutdown, type GracefulShutdownDeps } from "./server/shutdown";
