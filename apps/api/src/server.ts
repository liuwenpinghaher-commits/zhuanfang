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
  type BailianStreamingTtsClient
} from "./providers/bailian-streaming-tts";
import { isAuthGuardActive, isAuthorized } from "./auth";
import { createLlmBudget } from "./llm-budget";
import { resolveRequestTimeoutMs } from "./request-timeout";
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
  embeddingClient?: BailianEmbeddingClient;
  /** 测试/嵌入场景可覆盖；生产默认比底层百炼请求超时多 5 秒，用于清理与结构化响应。 */
  interviewTurnTimeoutMs?: number;
  env?: Record<string, string | undefined>;
  envFilePath?: string;
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
  const writeGate = registerWriteSerialization(server);
  registerErrorHandler(server);
  // R7:默认工厂只构造内存仓库(surreal 需异步连接,只能由 startServer 经 createSurrealStores 注入)。
  const innerProductStateRepository = options.productStateRepository ?? createDefaultProductStateRepository();
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
  if (isProductionProfile && !runtimeEnv.PRODUCT_API_TOKEN) {
    console.warn(JSON.stringify({
      event: "auth_guard_inactive_in_production",
      detail: "DEPLOYMENT_PROFILE=production 但未设 PRODUCT_API_TOKEN —— 鉴权守卫未启用,所有 /api/* 无凭据即可访问。"
    }));
  }
  // 生产 profile 却回落内存存储(通常是 PRODUCT_STORE=memory 或漏配 surreal 档) → 进程重启全部数据丢失。响亮告警。
  if (isProductionProfile && stateStore === "memory") {
    console.warn(JSON.stringify({
      event: "state_store_in_memory_in_production",
      detail: "生产 profile 使用内存状态存储(PRODUCT_STORE=memory 或 dbPath 为 :memory:) —— 进程重启将丢失全部数据。持久化请设 PRODUCT_STORE=surreal。"
    }));
  }
  // R7:三冷层(raw-material / audio / knowledge index)默认走内存;唯有 surreal 档由 startServer
  // 经 createSurrealStores 注入真实冷层(与热态同一嵌入式连接)。显式注入的 repo(测试/surreal)总是优先。
  const rawMaterialRepository =
    options.rawMaterialRepository ?? createDefaultRawMaterialRepository();
  const audioRepository = options.audioRepository ?? createDefaultAudioRepository();
  const knowledgeIndexRepository =
    options.knowledgeIndexRepository ?? createDefaultKnowledgeIndexRepository();
  const envFilePath = options.envFilePath ?? join(process.cwd(), ".env.local");

  // Single shared budget instance — covers all LLM entry points (interview turns,
  // pre-signals, corpus insights, reviews, import, search enrichment, podcast script).
  // Uses "system" key for non-session endpoints and session.id for session endpoints.
  const sharedBudget = createLlmBudget();

  // 持久化边界增量索引：包住 product-state 仓库，每次 replaceState 后 fire-and-forget 触发
  // 增量重索引（diff 出变更的可索引资产 → 删/重建块）。绝不 await、绝不阻塞写、绝不把错误抛回写路径。
  // 包装在 sharedBudget / knowledgeIndexRepository 就绪后做，使下游所有路由共用包装后的仓库。
  const productStateRepository = withKnowledgeReindex(
    innerProductStateRepository,
    knowledgeIndexRepository,
    () => providerClients.embeddingClient,
    sharedBudget
  );

  // E:surreal 权威库落库健康度探针 → /api/health 暴露 persist.degraded。R7:dual-write 已删除,
  // 权威库直接有 getPersistHealth;内存档无此方法 → undefined → health 只回 ok。
  const probePersistHealth = () => {
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
      env: runtimeEnv
    }));
  });
  void server.register(async (registeredServer) => {
    await registerCorpusRoutes(registeredServer, productStateRepository, withLiveProviderClients({
      llmBudget: sharedBudget
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
      llmBudget: sharedBudget
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
      llmBudget: sharedBudget
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
    server.setNotFoundHandler((request, reply) => {
      if (request.method === "GET" && !request.url.startsWith("/api/")) {
        return reply.sendFile("index.html");
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
 * 装配期一次性捕获会拿到陈旧引用。其余方法显式转发（接口仅 4 个方法，显式比展开更稳）。
 */
export function withKnowledgeReindex(
  inner: ProductStateRepository,
  knowledgeRepo: KnowledgeIndexRepository,
  getEmbeddingClient: () => BailianEmbeddingClient | undefined,
  budget: ReturnType<typeof createLlmBudget>
): ProductStateRepository {
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
        void reindexOnStateChange(prev, result, knowledgeRepo, getEmbeddingClient(), budget);
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
  const ttsApiKey = env.DASHSCOPE_API_KEY ?? env.BAILIAN_API_KEY;
  providerClients.streamingTtsClient =
    options.streamingTtsClient ??
    (ttsApiKey ? createBailianStreamingTtsClient({ apiKey: ttsApiKey }) : undefined);
}

// Global write serialization. Every mutating endpoint is a read-modify-write on the single
// shared ProductState with an await window in the middle (LLM / embedding / provider round-
// trips), and only PUT /api/state carries an optimistic-lock check. Without serialization two
// concurrent writes both read the same base snapshot and the second replaceState clobbers the
// first — a silently dropped session / memory candidate / audit event. This single chain makes
// every mutating request run one-at-a-time end-to-end. For a single-user local tool the
// throughput cost is negligible and it eliminates the lost-update class entirely (including the
// background research scheduler racing a user action). Reads (GET/HEAD/OPTIONS) are not gated.
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
// 写 slot 观测/自愈参数(真实业务 E2E 实测的死锁形态:某 mutating 请求的响应永不完成——客户端
// 中途断连/永挂 await——onResponse/onError 均不触发,slot 永久持有,所有后续写排队冻结,而读全部正常)。
const WRITE_SLOT_WAIT_WARN_MS = 10_000;   // 等锁超过此时长开始点名持锁者(每 10s 一条,凶手 URL 直接进日志)
// 审计修复(P2-20 + 回归审查 R3-B):上限须盖过**最长合法写**,否则合法长写被强放后以旧基整态覆盖
// 窗口内并发写(反向 clobber)。实测最长合法写:/end = 记忆抽取(60s)+finalize(180s)+矛盾精判(60s)
// +embedding(2×15s)≈330s;consolidate 已由 MAX_SUMMARY_CLUSTERS 限规模到上限内(见 memory-candidates)。
// 故上限提到 360s 覆盖 /end;真僵尸(断连腰斩)仍被 close 钩子即时放行,本上限只兜"永挂 await"极端
// (合法写不再触发它 → 消除"强放-覆盖")。多出的 120s 仅在真死锁时多冻结,close 钩子已覆盖常见断连。
export const WRITE_SLOT_MAX_HOLD_MS = 360_000;   // 持锁上限:盖过最长合法写(/end~330s),使合法长写不被强放-覆盖
// P3-10:把"上限须盖过 /end 最长合法写"从注释里的口头不变量变成可守护的常量。/end 各阶段预算:
// 记忆抽取 60s + finalize 180s + 矛盾精判 60s + embedding 2×15s = 330s。invariant:预算 ≤ 持锁上限
// (差额即"强放余量",当前 30s)。END_WRITE_PHASE_BUDGET_MS 上调越界会被 server 守护测试逮红,
// 而不是等生产里合法长写被强放-覆盖才发现。
export const END_WRITE_PHASE_BUDGET_MS = 60_000 + 180_000 + 60_000 + 2 * 15_000;   // = 330_000
export interface WriteGate {
  /** 内部写方(调度器/auto-run 终写)经此与 HTTP 串行写互斥;fn 应保持短小(读-合并-写)。 */
  runExclusive<T>(label: string, fn: () => Promise<T> | T): Promise<T>;
}

// ═══ R3 · 全局写锁豁免名单(声明式)══════════════════════════════════════════════════════
// 豁免的统一语义:**只豁免"handler 期间不整段持有全局写 slot",绝不豁免"终写绕过串行化"**。
// 每条被豁免路由的终写仍必须满足二者其一,否则会落进某个长持锁写(如 /end ~330s)的
// 读-await-写窗口中间被整态回滚(D3 反向 clobber 不变量,本仓库已付过 D3/R3-A/R3-B 三轮学费):
//   a) 终写经 writeGate.runExclusive 与在途持锁写互斥(auto-run 终写、R3 试点路由的 CAS commit);
//   b) 或路由自身持锁(不在本名单 = 默认整段持锁)。
// R3 试点路由(state-command.ts runStateCommand):handler 里的校验/embedding 在锁外并行,
// 终写=「读-算-写连续同步块 + expectedRevision CAS」经写门排队——微秒级持锁,热点写不再
// 端到端互相排队(P4 减半);治理在途如实 409。
//
// M4 · 段边界:豁免默认按段级精确匹配,不用裸 startsWith。裸前缀(如 `/api/memory-records/`)会把
// **未来**同前缀新增的路由(如带 embedding 的 PATCH /:id/annotate)自动豁免出全局写锁,而它可能
// 尚未做 D3 改造(embed 在读写窗口内、以旧基写回)→ 无声反向 clobber,正是最隐蔽的失败模式。
// 故:能精确到具体动作的用 `exactPath`/末段判定;`:id` 型用 `idUnder`(仅匹配 prefix+单段,拒绝
// 再有下级段)。★铁律:新增任何同前缀路由,必须显式回到本表评估 D3(handler 临界区是否有 await
// 外部 IO / 终写是否经写门),再决定加不加豁免——绝不靠"碰巧被前缀网住"。auto-run 是唯一保留裸
// 前缀者(它精确指向单一长联网端点族,无同前缀兄弟路由)。
interface WriteGateExemption {
  /** 限定 HTTP method;缺省 = 任意 mutating method。 */
  method?: string;
  /** 按 pathname 匹配(已剥 querystring)。 */
  matches: (pathname: string) => boolean;
  /** 为什么豁免是安全的(见上方统一语义;此处只记路由特有理由)。 */
  reason: string;
}
// prefix 必须以 "/" 结尾;仅匹配 prefix + 恰好一个非空段(其内不再含 "/")——即 `.../:id` 本身,
// 不匹配 `.../:id/子动作`。这把"未来同前缀慢 IO 子路由被自动豁免"的隐患挡在编译期之外。
const idUnder = (prefix: string) => (p: string): boolean => {
  if (!p.startsWith(prefix)) return false;
  const rest = p.slice(prefix.length);
  return rest.length > 0 && !rest.includes("/");
};
const WRITE_GATE_EXEMPTIONS: WriteGateExemption[] = [
  {
    // auto-run 是可达 90s 的长联网 mutating 请求。若占用全局写 slot 整个请求期间,会把所有其它写
    // (reset/用户操作)串行阻塞到它后面 → 后端"卡死不自恢复"(实测 GET 读不卡、reset 写卡满、无
    // event_loop_lag)。联网期间不碰 state,最终写已改为"重读 latest + 原子合并"且经
    // writeGate.runExclusive(search.ts commitFinal),并发由 autoRunInFlight 自管。
    matches: (p) => p.startsWith("/api/research/auto-run"),
    reason: "长联网请求;终写=重读 latest 原子合并,经写门(D3)"
  },
  {
    // 回归审查 R6-6 → R3:PATCH 记忆记录 handler 会 await embedding(慢网络 IO,数百 ms)。
    // embed 在锁外先算,同步 RMW 已换轨 runStateCommand(CAS commit 经写门)——低频编辑不再
    // 持全局 slot 整个 embed 期间阻塞其它写。M4:段级精确到 `.../:id`,未来 `.../:id/annotate`
    // 等慢 IO 子路由不再被自动豁免(须显式评估 D3 后再入表)。
    method: "PATCH",
    matches: idUnder("/api/memory-records/"),
    reason: "R3 试点:embed 锁外,同步 RMW 走 CAS(commit 经写门)"
  },
  {
    // R3 试点:删除记忆记录——纯同步小 RMW(无外部 IO),mutate 基于最新态重找实体,CAS commit 经写门。
    // M4:段级精确到 `.../:id`(DELETE 无同前缀子路由,收窄纯为一致性与未来防呆)。
    method: "DELETE",
    matches: idUnder("/api/memory-records/"),
    reason: "R3 试点:纯同步小 RMW,走 CAS(commit 经写门)"
  },
  {
    // R3 试点:废弃记忆记录——纯同步小 RMW,同上。
    method: "POST",
    matches: (p) => p.startsWith("/api/memory-records/") && p.endsWith("/deprecate"),
    reason: "R3 试点:纯同步小 RMW,走 CAS(commit 经写门)"
  },
  {
    // R3 试点:决策确认(前端唯一走服务端的资产写,带权威语义)——纯同步小 RMW,CAS 内含
    // "已确认→409"前置校验,同实体并发确认恰好一胜一 409(契约见 assets.ts)。
    method: "POST",
    matches: (p) => p.startsWith("/api/assets/decisions/") && p.endsWith("/confirm"),
    reason: "R3 试点:纯同步小 RMW,走 CAS(commit 经写门)"
  },
  {
    // R3 试点:playbook 补丁状态流转(apply/revert)——纯同步小 RMW(proposed→applied→reverted
    // 状态机在域层纯函数内),CAS 前置校验拦非法流转。
    method: "POST",
    matches: (p) => p.startsWith("/api/playbook-patches/") && (p.endsWith("/apply") || p.endsWith("/revert")),
    reason: "R3 试点:纯同步小 RMW,走 CAS(commit 经写门)"
  },
  {
    // R3 试点:记忆候选文本编辑——纯同步小 RMW。M4:段级精确到 `.../:id`——同前缀的 POST
    // /:id/approve(读写之间 await embedding 且以旧基写回)本就是 POST 且带子段,双重不命中;
    // 未来任何 PATCH /:id/子动作 也不再被自动豁免。POST /api/memory/consolidate 前缀不同(/api/memory/),
    // 天然不匹配,仍整段持锁(LLM 在临界区)。
    method: "PATCH",
    matches: idUnder("/api/memory-candidates/"),
    reason: "R3 试点:纯同步小 RMW,走 CAS(commit 经写门)"
  },
  {
    // R3 试点:记忆候选拒绝——纯同步小 RMW(pending→rejected),同上;approve 不在名单内。
    method: "POST",
    matches: (p) => p.startsWith("/api/memory-candidates/") && p.endsWith("/reject"),
    reason: "R3 试点:纯同步小 RMW,走 CAS(commit 经写门)"
  },
  {
    // P3-17:声纹注册——外呼 voiceEnrollmentClient(数秒),【无任何 ProductState 终写】。
    // 此前整段持全局写锁,把用户 autosave/reset 等真正的写全冻在这几秒后面。纯外呼无终写→豁免。
    method: "POST",
    matches: (p) => p === "/api/realtime-voice/voices",
    reason: "P3-17:无 state 终写(纯外呼声纹注册),持锁无意义"
  },
  {
    // P3-17:删除声纹——外呼 deleteVoice,无 state 终写,同上。
    method: "DELETE",
    matches: idUnder("/api/realtime-voice/voices/"),
    reason: "P3-17:无 state 终写(纯外呼删声纹),持锁无意义"
  },
  {
    // P3-17:构建实时语音指令——await embedQueryText(慢嵌入 IO,数百 ms)后只读拼指令返回,
    // 【无 replaceState】。此前整段持锁把嵌入耗时算进全局写串行,纯读+外呼→豁免。
    method: "POST",
    matches: (p) => p.startsWith("/api/interview-sessions/") && p.endsWith("/voice-instructions"),
    reason: "P3-17:无 state 终写(纯读+嵌入外呼),持锁无意义"
  }
];

/**
 * R3:写锁豁免判定(供 preHandler 与测试使用)。整包 PUT /api/state、interview /end、治理路由
 * (reset/purge/import)、语音/长联网路由等一律不在名单内 → 默认整段持锁(宽事务本该串行)。
 */
export function isWriteGateExempt(method: string, url: string): boolean {
  const pathname = url.split("?")[0] ?? url;
  return WRITE_GATE_EXEMPTIONS.some(
    (rule) => (rule.method === undefined || rule.method === method) && rule.matches(pathname)
  );
}

function registerWriteSerialization(server: ReturnType<typeof Fastify>): WriteGate {
  let writeQueue: Promise<void> = Promise.resolve();
  const releases = new WeakMap<FastifyRequest, () => void>();
  // 当前持锁者快照:写路径卡死时日志能直接指认,而不是集体沉默。
  let holder: { label: string; since: number } | null = null;

  server.addHook("preHandler", async (request: FastifyRequest, reply: FastifyReply) => {
    if (!MUTATING_METHODS.has(request.method)) {
      return;
    }
    // R3:声明式豁免名单(每条的安全论证见 WRITE_GATE_EXEMPTIONS 各条目注释)。
    if (isWriteGateExempt(request.method, request.url)) {
      return;
    }
    const label = `${request.method} ${request.url}`;
    let release!: () => void;
    const slot = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prior = writeQueue;
    writeQueue = writeQueue.then(() => slot); // enqueue our slot synchronously, in arrival order

    let maxHoldTimer: NodeJS.Timeout | undefined;
    let released = false;
    const releaseOnce = () => {
      if (released) return;
      released = true;
      if (maxHoldTimer) clearTimeout(maxHoldTimer);
      if (holder?.label === label) holder = null;
      release();
    };
    releases.set(request, releaseOnce);

    // 等待观测:>10s 未拿到锁 → 周期性点名持锁者(诊断死锁必需;此前只能看到"全部写都卡")。
    const waitStart = Date.now();
    const warnTimer = setInterval(() => {
      console.error(JSON.stringify({
        event: "write_slot_blocked",
        waiting: label,
        waitedMs: Date.now() - waitStart,
        heldBy: holder?.label ?? "unknown",
        heldForMs: holder ? Date.now() - holder.since : undefined
      }));
    }, WRITE_SLOT_WAIT_WARN_MS);
    try {
      await prior; // block here until every earlier write has released
    } finally {
      clearInterval(warnTimer);
    }
    holder = { label, since: Date.now() };

    // 持锁上限:响应永不完成的请求(断连腰斩/永挂 await)不再永久冻结全部写路径——强放并响亮记账。
    maxHoldTimer = setTimeout(() => {
      console.error(JSON.stringify({ event: "write_slot_force_released", holder: label, heldForMs: WRITE_SLOT_MAX_HOLD_MS }));
      releaseOnce();
    }, WRITE_SLOT_MAX_HOLD_MS);
    // 客户端断连即放行:onResponse/onError 在"响应永不完成"时都不会触发(E2E 实测死锁形态);
    // ServerResponse 'close' 在正常完成与提前断连两种情况都触发,释放是幂等的,可安全兜底。
    reply.raw.once("close", releaseOnce);
  });

  const release = async (request: FastifyRequest) => {
    const fn = releases.get(request);
    if (fn) {
      releases.delete(request);
      fn();
    }
  };
  server.addHook("onResponse", release);
  server.addHook("onError", async (request: FastifyRequest, _reply: FastifyReply, _err: Error) => {
    await release(request);
  });

  // 审计修复(D3/D4):内部写方入口——后台调度器与 auto-run 终写此前完全绕开串行化,
  // 与在途 HTTP 写互相 clobber。经同一队列排队,fn 短小(同步读-合并-写),不设 watchdog。
  return {
    async runExclusive<T>(label: string, fn: () => Promise<T> | T): Promise<T> {
      let release!: () => void;
      const slot = new Promise<void>((resolve) => {
        release = resolve;
      });
      const prior = writeQueue;
      writeQueue = writeQueue.then(() => slot);
      await prior;
      const gateLabel = `internal:${label}`;
      holder = { label: gateLabel, since: Date.now() };
      // 回归审查 R3-D:与 preHandler 对齐的持锁上限强放(防御纵深)——当前调用方 fn 都是同步快速的
      // 读-合并-写,但签名允许异步;若未来传入挂起的异步 fn,无此兜底会永久冻结全部 HTTP 写队列。
      let released = false;
      const releaseOnce = () => { if (released) return; released = true; if (holder?.label === gateLabel) holder = null; release(); };
      const maxHoldTimer = setTimeout(() => {
        console.error(JSON.stringify({ event: "write_slot_force_released", holder: gateLabel, heldForMs: WRITE_SLOT_MAX_HOLD_MS }));
        releaseOnce();
      }, WRITE_SLOT_MAX_HOLD_MS);
      try {
        return await fn();
      } finally {
        clearTimeout(maxHoldTimer);
        releaseOnce();
      }
    }
  };
}

// Global error handler. Routes that validate return explicit 4xx via reply.code(...).send(...)
// and never reach here; this catches UNCAUGHT throws. Client errors (statusCode 4xx, e.g. a
// payload-too-large) keep their status + message, but server faults (5xx / no statusCode) are
// logged in full server-side and replaced with a generic body so internal error text, stack
// hints, or secrets never reach the client (CLAUDE.md: never leak internal errors).
function registerErrorHandler(server: ReturnType<typeof Fastify>) {
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

function registerCors(server: ReturnType<typeof Fastify>, env: Record<string, string | undefined>) {
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
      reply.header("access-control-allow-origin", allowedOrigin);
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
export function assertProductionAuthConfigured(env: Record<string, string | undefined>) {
  const isProduction = (env.DEPLOYMENT_PROFILE ?? "").trim().toLowerCase() === "production";
  if (isProduction && !env.PRODUCT_API_TOKEN) {
    throw new Error(
      "生产部署 (DEPLOYMENT_PROFILE=production) 必须配置 PRODUCT_API_TOKEN：缺少令牌时鉴权守卫不会生效，所有 /api/* 路由（隐私导出、一键清空、修改 provider 配置、语音代理）将无凭据即可访问。请设置 PRODUCT_API_TOKEN 后再启动。"
    );
  }
}

// Paths exempted from bearer auth in production profile (healthcheck, metrics, etc.)
const AUTH_EXEMPT_PREFIXES = ["/api/health"];

function registerProductionAuth(server: ReturnType<typeof Fastify>, env: Record<string, string | undefined>) {
  // Auth guard is only active in production profile WITH a token — keeps local dev friction-free.
  if (!isAuthGuardActive(env)) {
    return;
  }

  server.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    const path = request.url.split("?")[0];

    // Exempt health check (and any future non-/api paths are already not API routes)
    if (AUTH_EXEMPT_PREFIXES.some((prefix) => path === prefix || path.startsWith(prefix + "/"))) {
      return;
    }

    // Only guard /api/* routes; static assets served outside /api should pass through
    if (!path.startsWith("/api/")) {
      return;
    }

    // 同时接受 ?token= 查询:浏览器原生媒体请求(<audio src>/<img>)无法带 Authorization 头,
    // 没有这条,生产环境下原生 src 形式的音频回放等 GET 会被 401。与 WS 升级路径口径一致。
    const tokenQuery = new URLSearchParams(request.url.split("?")[1] ?? "").get("token") ?? undefined;
    if (isAuthorized(env, { authHeader: request.headers.authorization, tokenQuery })) {
      return;
    }

    return reply.code(401).send({ error: "Unauthorized" });
  });
}

// R7:默认工厂只构造内存仓库。持久化(surreal 热态 + 三冷层)需异步连接,无法在同步的 buildApiServer
// 装配期建立,只能由 startServer 经 createSurrealStores 打开共享连接后注入。故这四个默认工厂不再看
// dbPath——真实 dbPath 也不落盘,持久化一律走 surreal 档的显式注入路径。
function createDefaultProductStateRepository() {
  return createInMemoryProductStateRepository();
}

function createDefaultRawMaterialRepository() {
  return createInMemoryRawMaterialRepository();
}

function createDefaultKnowledgeIndexRepository() {
  return createInMemoryKnowledgeIndexRepository();
}

function createDefaultAudioRepository() {
  return createInMemoryAudioRepository();
}

/** N-10:给一个 promise 加超时——到点 reject(Error("<label> timeout"))。调用方 catch 后继续
 *  走关闭序列(绝不因某一步卡住而永不退出)。settle 后清 timer,不留悬挂计时器。 */
function withDeadline<T>(p: Promise<T>, ms: number, label = "operation"): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

export interface GracefulShutdownDeps {
  /** 停止收新请求(Fastify server.close;排空在途 HTTP)。 */
  closeServer: () => Promise<void>;
  /** 排空持久化——surreal 档 = stores.close(先 flush persist 队列再关连接);memory 档 = flush(no-op 也无妨)。 */
  flushPersistence: () => Promise<void>;
  /** 关闭 OTel(数据 flush 之后才调,内部已吞错)。 */
  shutdownTelemetry: () => Promise<void>;
  /** 退出进程(注入以便单测断言,不真的杀测试进程)。 */
  exit: (code: number) => void;
  /** flush 上限超时(默认 10s):flush 卡住不永久挂起,超时强退并记「可能丢失未落库写」。 */
  flushTimeoutMs?: number;
  /** server.close 上限超时(默认 8s):某个永挂的在途请求不该挡住 flush 步骤。 */
  closeTimeoutMs?: number;
}

/**
 * N-10:统一优雅关闭序列(数据 flush 优先于 OTel)。抽成可注入依赖的工厂,便于单测断言
 * 「close → flush → OTel → exit」顺序、幂等(重复信号只跑一次)、flush 超时兜底(不卡死)。
 *
 * 序列:① closeServer() 停止收新请求(排空在途 HTTP,有界超时——永挂请求不该挡住 flush);
 * ② flushPersistence() 排空 persist 队列——R7 删同步 sqlite 后这是唯一持久路径,不 flush 直接退
 * 会丢已确认 200 的写(常态窗口小,但重试期/积压/降级期 N-02 窗口可无限);③ shutdownTelemetry()
 * 关 OTel(数据已落库);④ exit(0)。② 加上限超时:超时后强制走完 OTel + exit,并 console.error
 * 记「可能丢失未落库写」(至少留信号,呼应 N-02)。任一步抛错都不阻断后续步骤(尽力走到 exit)。
 */
export function createGracefulShutdown(deps: GracefulShutdownDeps): (signal: string) => Promise<void> {
  const flushTimeoutMs = deps.flushTimeoutMs ?? 10_000;
  const closeTimeoutMs = deps.closeTimeoutMs ?? 8_000;
  let shuttingDown = false;
  return async (signal: string) => {
    // 幂等防重入:第二个信号(SIGINT 后 SIGTERM,或同信号重发)直接返回,绝不重复跑关闭序列。
    if (shuttingDown) return;
    shuttingDown = true;
    console.warn(JSON.stringify({ event: "graceful_shutdown_start", signal }));

    // ① 停止收新请求(有界:永挂的在途请求不该挡住 flush 步骤)。
    try {
      await withDeadline(deps.closeServer(), closeTimeoutMs, "server_close");
    } catch (err) {
      console.error(JSON.stringify({
        event: "graceful_shutdown_server_close_failed",
        error: err instanceof Error ? err.message : String(err)
      }));
    }

    // ② 排空 persist 队列(数据优先于 OTel)。超时兜底 → 至少留信号,不永久挂起。
    try {
      await withDeadline(deps.flushPersistence(), flushTimeoutMs, "flush");
    } catch (err) {
      console.error(JSON.stringify({
        event: "graceful_shutdown_flush_failed",
        error: err instanceof Error ? err.message : String(err),
        detail: "persist 队列未能在超时内排空,可能丢失未落库的写(已确认 200 但未落 surreal 权威库)。"
      }));
    }

    // ③ 关 OTel(数据已 flush;shutdownTelemetry 内部已吞错,此处再兜一层保证到达 exit)。
    try {
      await deps.shutdownTelemetry();
    } catch { /* 已在 shutdownTelemetry 内记账;绝不阻断 exit */ }

    // ④ 退出。
    deps.exit(0);
  };
}

export async function startServer() {
  loadLocalEnvFile();

  // I 预热:本地 embedding(transformers.js)首次需加载模型(~数十秒)。启动即后台预热,让首个
  // "开始专访"不撞冷加载(embedQueryText 有 8s 超时,未预热完只是降级关键词召回、不卡住)。
  // fire-and-forget + catch:预热失败绝不阻塞启动;单例 extractorPromise 模块级,与路由层共享同一次加载。
  if ((process.env.EMBEDDING_PROVIDER ?? "").trim().toLowerCase() === "local") {
    void createLocalEmbeddingClient().embed(["预热"]).catch(() => {});
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

  // R2a:surreal 档下热态 + 三冷层共用同一嵌入式连接(嵌入式 surrealkv 同进程独占锁,不能开第二连接)。
  // createSurrealStores 打开一个连接、applySchema 一次,返回热态仓库 + 三冷层仓库。
  const loadSurrealStores = async () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const mod = await (Function("p", "return import(p)") as (p: string) => Promise<{
      createSurrealStores: (opts: { url: string }) => Promise<{
        productState: ProductStateRepository;
        rawMaterial: RawMaterialRepository;
        audio: AudioRepository;
        knowledgeIndex: KnowledgeIndexRepository;
        // N-10:优雅关闭用——先 flush 热态 persist 队列、再关共享嵌入式连接。
        close: () => Promise<void>;
      }>;
    }>)(new URL("../../../packages/db/src/surreal/surreal-cold-repositories.ts", import.meta.url).pathname);
    const dataDir = join(dirname(productStateDbPath), "surreal");
    return mod.createSurrealStores({ url: `surrealkv://${dataDir}/surreal` });
  };

  let repository: ProductStateRepository;
  // N-10:surreal 档的「flush persist 队列 + 关共享连接」句柄(优雅关闭时调);memory 档为 undefined。
  let storesClose: (() => Promise<void>) | undefined;
  // R7:档位收敛为 memory|surreal 两档。surreal 档注入 Surreal 冷层(与热态同连接);memory 档
  // 冷层 undefined → buildApiServer 走默认内存工厂。
  let surrealColdRepos: {
    rawMaterialRepository?: RawMaterialRepository;
    audioRepository?: AudioRepository;
    knowledgeIndexRepository?: KnowledgeIndexRepository;
  } = {};
  if (productStore === "memory") {
    // F-02/A2:in-memory 档位(sentinel 或显式 PRODUCT_STORE=memory)。productStateDbPath 此时
    // 恒为 sentinel,buildApiServer 的冷层默认工厂(raw/audio/knowledge)同走内存,零落盘。
    repository = createInMemoryProductStateRepository();
    console.warn(JSON.stringify({
      event: "product_store",
      mode: "memory",
      reason: selection.reason,
      // sentinel 压过档位继承时响亮注明,避免运维误以为持久档生效。
      ...(selection.ignoredProductStore ? { ignoredProductStore: selection.ignoredProductStore } : {})
    }));
  } else {
    // R7:surreal 是唯一持久档(未设/未知/已废弃档位均已在 resolveProductStoreSelection 归一到此)。
    // R2a:热态 + 三冷层共用同一嵌入式连接(嵌入式 surrealkv 同进程独占锁,不能开第二连接)。
    // N-07:嵌入式 surrealkv 同进程独占锁——若另一进程已持锁,connect 会静默永挂。
    // createSurrealConnection 已加超时抛 SurrealConnectTimeoutError;这里指认数据目录后 exit 1,
    // 让运维一眼看到"疑似双开"而非盯着无输出的挂死进程猜。
    let stores: Awaited<ReturnType<typeof loadSurrealStores>>;
    try {
      stores = await loadSurrealStores();
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
    ...surrealColdRepos,
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
      // surreal 档:stores.close() 先 flush 热态 persist 队列、再关共享嵌入式连接。
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
