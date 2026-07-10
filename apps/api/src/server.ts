// OpenTelemetry must be initialized before any other imports
import "./telemetry";

import Fastify, { type FastifyRequest, type FastifyReply } from "fastify";
import fastifyStatic from "@fastify/static";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createSqliteProductStateRepository } from "../../../packages/db/src/sqlite-product-state-repository";
import { createSqliteRawMaterialRepository } from "../../../packages/db/src/sqlite-raw-material-repository";
import { createSqliteAudioRepository } from "../../../packages/db/src/sqlite-audio-repository";
import { createSqliteKnowledgeIndexRepository } from "../../../packages/db/src/sqlite-knowledge-index-repository";
import { loadLocalEnvFile } from "./env";
import { isInMemoryDbPath, resolveProductStoreSelection, type ProductStoreMode } from "./store-selection";
import { createInMemoryProductStateRepository, type ProductStateRepository } from "./product-state-repository";
// F-01/A1:仅类型引用(readStateOrExplain 的签名)。
import type { ProductState } from "../../../src/domain/types";
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
   * 真实存储。不传时按 stateStore(memory/sqlite)如实推断——buildApiServer 的默认工厂只会
   * 构造这两种,绝不按 env.PRODUCT_STORE 谎报 dual/surreal。
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
  const innerProductStateRepository = options.productStateRepository ?? createDefaultProductStateRepository(options.productStateDbPath);
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
  const effectiveDbPath = options.productStateDbPath ?? runtimeEnv.PRODUCT_STATE_DB_PATH;
  const stateStore: "memory" | "sqlite" =
    effectiveDbPath && !isInMemoryDbPath(effectiveDbPath) ? "sqlite" : "memory";

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
  // 生产 profile 却回落内存存储(通常是漏设 PRODUCT_STATE_DB_PATH) → 进程重启全部数据丢失。响亮告警。
  if (isProductionProfile && stateStore === "memory") {
    console.warn(JSON.stringify({
      event: "state_store_in_memory_in_production",
      detail: "生产 profile 使用内存状态存储(未设 PRODUCT_STATE_DB_PATH 或为 :memory:) —— 进程重启将丢失全部数据。"
    }));
  }
  // Raw-material cold storage lives next to the product-state db (raw-material.sqlite
  // in the same directory). Tests / in-memory deployments stay in-memory so they
  // never touch disk. An explicitly injected repo (tests) always wins.
  const rawMaterialRepository =
    options.rawMaterialRepository ?? createDefaultRawMaterialRepository(effectiveDbPath);
  // Interview raw-audio cold storage lives next to the product-state db (audio.sqlite in
  // the same directory). Tests / in-memory deployments stay in-memory. Injected repo wins.
  const audioRepository = options.audioRepository ?? createDefaultAudioRepository(effectiveDbPath);
  // Knowledge index (cross-source RAG chunks) lives next to the product-state db
  // (knowledge.sqlite in the same directory). Tests / in-memory deployments stay
  // in-memory. Injected repo wins.
  const knowledgeIndexRepository =
    options.knowledgeIndexRepository ?? createDefaultKnowledgeIndexRepository(effectiveDbPath);
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

  // E:权威库(surreal / dual-surreal)落库健康度探针 → /api/health 暴露 persist.degraded。
  // surreal 权威直接有 getPersistHealth;dual-surreal 经 getAuthoritative 取到 surreal 权威库;sqlite/dual → undefined。
  const probePersistHealth = () => {
    const repo = innerProductStateRepository as {
      getPersistHealth?: () => { consecutiveFailures: number; lastError?: string; lastErrorAt?: string };
      getAuthoritative?: () => { getPersistHealth?: () => { consecutiveFailures: number; lastError?: string; lastErrorAt?: string } };
    };
    return repo.getPersistHealth?.() ?? repo.getAuthoritative?.().getPersistHealth?.();
  };
  // 方案二:图↔软链一致性审计探针(同一注入矩阵:surreal 直接有 / dual-surreal 经 getAuthoritative /
  // sqlite、dual → undefined → 路由回 501)。方法是 handle 闭包实现、不依赖 this,解包后直调安全。
  type GraphAuditFn = () => Promise<{
    ok: boolean; auditedEdgeTables: string[]; expectedCount: number; actualCount: number;
    missingCount: number; unexpectedCount: number; missingInDb: string[]; unexpectedInDb: string[];
    danglingProvenanceCount: number;
    nodeMissingCount: number; nodeUnexpectedCount: number; nodeMissingInDb: string[]; nodeUnexpectedInDb: string[];
  }>;
  const probeGraphAudit = () => {
    const repo = innerProductStateRepository as {
      auditGraphConsistency?: GraphAuditFn;
      getAuthoritative?: () => { auditGraphConsistency?: GraphAuditFn };
    };
    const audit = repo.auditGraphConsistency ?? repo.getAuthoritative?.().auditGraphConsistency;
    return audit?.();
  };
  void server.register(registerHealthRoutes(probePersistHealth, probeGraphAudit));
  void server.register(async (registeredServer) => {
    await registerSystemRoutes(registeredServer, productStateRepository, {
      stateStore,
      // 审计修复(P3-47→F-02/A2):真实权威库档位透出(dual-surreal 下 stateStore 仍是 sqlite)。
      // 改为只信 startServer 解析后传入的 mode,不再读 env.PRODUCT_STORE——嵌入/测试路径下
      // buildApiServer 的默认工厂只构造 memory/sqlite,按 env 上报会在 sentinel 场景下撒谎。
      // 未传时直传 undefined:`?? stateStore` 如实回落只归 system.ts 一处,避免双份兜底漂移。
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
      llmBudget: sharedBudget
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
      llmBudget: sharedBudget
    }));
  });
  void server.register(async (registeredServer) => {
    await registerAssetRoutes(registeredServer, productStateRepository);
  });
  void server.register(async (registeredServer) => {
    await registerPlaybookPatchRoutes(registeredServer, productStateRepository);
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
    // 能力透传(P2b 生产可达性修复):此前只回 4 个接口方法,把 inner(surreal handle /
    // dual 的 getAuthoritative)的原生召回能力全部吞掉 → 路由层 asNativeRecall(wrapped)
    // 恒 undefined,原生召回在生产静默失效、fail-safe 回落把问题掩成"一切正常"。
    // spread 透传 own 方法(repo 各实现均为闭包方法的对象字面量,不依赖 this,解包安全),
    // 使 asNativeRecall 的注入矩阵(surreal 直达 / dual-surreal 经 getAuthoritative)真正可达;
    // 后声明的同名键覆盖 spread,读写语义与此前完全一致。
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
const WRITE_SLOT_MAX_HOLD_MS = 360_000;   // 持锁上限:盖过最长合法写(/end~330s),使合法长写不被强放-覆盖
export interface WriteGate {
  /** 内部写方(调度器/auto-run 终写)经此与 HTTP 串行写互斥;fn 应保持短小(读-合并-写)。 */
  runExclusive<T>(label: string, fn: () => Promise<T> | T): Promise<T>;
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
    // 豁免:auto-run 是可达 90s 的长联网 mutating 请求。若占用全局写 slot 整个请求期间,会把所有其它写
    // (reset/用户操作)串行阻塞到它后面 → 后端"卡死不自恢复"(实测 GET 读不卡、reset 写卡满、无 event_loop_lag)。
    // auto-run 联网期间并不碰 state(只 read-at-start + 最后一次 replaceState),且其最终写已改为"重读 latest
    // + 原子合并"(search.ts:auto-run),连续同步不被打断、不会 clobber 并发写;并发由 autoRunInFlight 自管。安全豁免。
    if (request.url.startsWith("/api/research/auto-run")) {
      return;
    }
    // 回归审查 R6-6:PATCH 记忆记录 handler 会 await embedding(慢网络 IO,数百 ms)。它已改为 embed 在
    // 锁外先算、只把同步 RMW 包进 writeGate.runExclusive(重读 latest 原子合并,并发安全),故豁免其全局
    // preHandler 写锁——低频编辑不再持全局 slot 整个 embed 期间阻塞其它写。仅 PATCH 豁免(DELETE/deprecate
    // 无 embed、快速同步,继续走全局锁)。
    if (request.method === "PATCH" && request.url.startsWith("/api/memory-records/")) {
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

function createDefaultProductStateRepository(dbPath = process.env.PRODUCT_STATE_DB_PATH) {
  if (dbPath && !isInMemoryDbPath(dbPath)) {
    return createSqliteProductStateRepository({ dbPath });
  }
  return createInMemoryProductStateRepository();
}

function createDefaultRawMaterialRepository(productStateDbPath?: string) {
  if (productStateDbPath && !isInMemoryDbPath(productStateDbPath)) {
    return createSqliteRawMaterialRepository({
      dbPath: join(dirname(productStateDbPath), "raw-material.sqlite")
    });
  }
  return createInMemoryRawMaterialRepository();
}

function createDefaultKnowledgeIndexRepository(productStateDbPath?: string) {
  if (productStateDbPath && !isInMemoryDbPath(productStateDbPath)) {
    return createSqliteKnowledgeIndexRepository({
      dbPath: join(dirname(productStateDbPath), "knowledge.sqlite")
    });
  }
  return createInMemoryKnowledgeIndexRepository();
}

function createDefaultAudioRepository(productStateDbPath?: string) {
  if (productStateDbPath && !isInMemoryDbPath(productStateDbPath)) {
    return createSqliteAudioRepository({
      dbPath: join(dirname(productStateDbPath), "audio.sqlite")
    });
  }
  return createInMemoryAudioRepository();
}

// isInMemoryDbPath 已搬到 store-selection.ts(F-02/A2):startServer 与默认工厂必须共用同一份
// sentinel 判定,否则 "memory" 会在 startServer 路径被当成普通文件路径交给 SQLite 工厂。

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
  // 否则 E2E 只设 PRODUCT_STATE_DB_PATH=memory 时会继承 .env.local 的 dual-surreal 连上真实存储。
  const selection = resolveProductStoreSelection(process.env);
  const { mode: productStore, productStateDbPath } = selection;

  // P1a/P1d:动态 import surreal 工厂(避开 apps/api tsconfig moduleResolution:Node 对 @surrealdb/node 的类型检查)。
  // packages/db/tsconfig.json 用 moduleResolution:bundler 覆盖这些文件。
  const loadSurreal = async () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const mod = await (Function("p", "return import(p)") as (p: string) => Promise<{
      createSurrealProductStateRepository: (opts: { url: string }) => Promise<ProductStateRepository>;
    }>)(new URL("../../../packages/db/src/surreal/surreal-product-state-repository.ts", import.meta.url).pathname);
    const dataDir = join(dirname(productStateDbPath), "surreal");
    return mod.createSurrealProductStateRepository({ url: `surrealkv://${dataDir}/surreal` });
  };

  let repository: ProductStateRepository;
  if (productStore === "memory") {
    // F-02/A2:in-memory 档位(sentinel 或显式 PRODUCT_STORE=memory)。productStateDbPath 此时
    // 恒为 sentinel,buildApiServer 里的冷层默认工厂(raw/audio/knowledge)据此同走内存,零落盘。
    repository = createInMemoryProductStateRepository();
    console.warn(JSON.stringify({
      event: "product_store",
      mode: "memory",
      reason: selection.reason,
      // sentinel 压过档位继承时响亮注明,避免运维误以为 dual-surreal 生效。
      ...(selection.ignoredProductStore ? { ignoredProductStore: selection.ignoredProductStore } : {})
    }));
  } else if (productStore === "surreal") {
    // P1a:纯 SurrealDB,opt-in。
    repository = await loadSurreal();
    console.warn(JSON.stringify({ event: "product_store", mode: "surreal" }));
  } else if (productStore === "dual") {
    // P1d:sqlite 权威 + surreal 影子。观察等价,sqlite 仍是真相、零风险。
    const sqlite = createSqliteProductStateRepository({ dbPath: productStateDbPath });
    const surreal = await loadSurreal();
    const { createDualWriteRepository } = await import("./dual-write-repository");
    repository = createDualWriteRepository({ authoritative: sqlite, shadow: surreal });
    console.warn(JSON.stringify({ event: "product_store", mode: "dual", detail: "sqlite 权威 / surreal 影子" }));
  } else if (productStore === "dual-surreal") {
    // 审计修复(F-01/A1,升级 D6/P1-4):回退后再切回、或漏 migrate 直切时,surreal 处女库会成为
    // 权威并在**首笔写**时镜像覆盖 sqlite 冷备的真实数据(mirror 后比对恒等,零告警)。旧版只
    // console.warn——半夜自动重启没人看日志,告警挡不住覆盖。现改为启动期用 assessDualSurrealCutover
    // (内容摘要 + 实体数 + revision 三重判据)决策:疑似"近空权威覆盖有数据冷备"默认 fail-closed,
    // 绝不监听端口;人工确认覆盖需显式设 ALLOW_DUAL_SURREAL_AUTHORITY_MISMATCH=true。
    // P1d:surreal 权威 + sqlite 冷备。切读 surreal,sqlite 仍写以便回退。
    const sqlite = createSqliteProductStateRepository({ dbPath: productStateDbPath });
    const surreal = await loadSurreal();
    const { createDualWriteRepository } = await import("./dual-write-repository");
    const { assessDualSurrealCutover, readCutoverMarker } = await import("./dual-surreal-cutover");
    // F-01:读不到任一库的状态就无法做安全评估,必须失败(fail-closed 精神)。但各自 try/catch
    // 把裸异常(如 SQLITE_CORRUPT 栈)升格为带定位与修复指引的结构化事件后再 throw——冷备损坏
    // 半夜发生时,值班第一眼要能看出"哪个库、哪个文件、怎么办",而不是一条 SQLITE 栈。
    const readStateOrExplain = (which: "surreal" | "sqlite", read: () => ProductState): ProductState => {
      try {
        return read();
      } catch (err) {
        console.error(JSON.stringify({
          event: "dual_surreal_state_read_failed",
          store: which,
          dbPath: which === "sqlite" ? productStateDbPath : join(dirname(productStateDbPath), "surreal"),
          error: err instanceof Error ? err.message : String(err),
          remediation: which === "sqlite"
            ? "sqlite 冷备读取失败(文件损坏?):修复或把损坏的 db 文件移走后重启。注意:移走后冷备为空库,启动检查会按'反向自愈'放行(镜像把权威数据补进新冷备),这是预期方向——但请先确认 surreal 权威库数据完好再移。"
            : "surreal 权威库读取失败:检查 surreal 数据目录是否损坏/被其他进程锁住(嵌入式 surrealkv 同进程独占),修复或移走损坏目录后重跑 migrate 再启动。"
        }));
        throw err; // startServer 顶层 catch 会 exit(1);评估不了安全性就绝不监听端口。
      }
    };
    const assessment = assessDualSurrealCutover({
      surrealState: readStateOrExplain("surreal", () => surreal.getState()),
      sqliteState: readStateOrExplain("sqlite", () => sqlite.getState()),
      allowMismatchEnv: process.env.ALLOW_DUAL_SURREAL_AUTHORITY_MISMATCH
    });
    if (assessment.action === "fail-closed") {
      // marker 仅诊断("上次迁移完成于 X / 从未迁移"),不参与放行判定——过期 marker 不能证明
      // 当下两库一致,凭它绕过 digest 检查恰好放行本修复要堵的覆盖路径(见 readCutoverMarker 注释)。
      const marker = readCutoverMarker(join(dirname(productStateDbPath), "surreal"));
      console.error(JSON.stringify({
        event: "dual_surreal_authority_mismatch_fail_closed",
        rule: assessment.rule,
        reason: assessment.reason,
        ...assessment.detail,
        // marker 的 counts 是 migrate 脚本口径(6 数组明细),与上面 detail 的 userEntityCount
        // (16 数组)口径不同——只透传明细不做求和,避免两个名同义异的总数并排误导运维。
        cutoverMarker: marker ? { migratedAt: marker.migratedAt, sourceSqliteRevision: marker.sourceSqliteRevision, counts: marker.counts } : "从未迁移(未发现 cutover-marker.json)",
        remediation: [
          "①运行 node scripts/migrate-sqlite-to-surreal.mjs(经 npx tsx)完成 sqlite→surreal 迁移后再切 dual-surreal;",
          "②确属人工恢复、要以 surreal 当前内容为准覆盖 sqlite 冷备时,显式设 ALLOW_DUAL_SURREAL_AUTHORITY_MISMATCH=true 放行。"
        ]
      }));
      // startServer 顶层 catch 会 exit(1)——服务在监听端口之前终止,冷备数据不会被首笔写覆盖。
      throw new Error(`dual-surreal 权威库可疑,拒绝启动(F-01 fail-closed):${assessment.reason}`);
    }
    if (assessment.action === "proceed-with-override") {
      console.warn(JSON.stringify({
        event: "dual_surreal_authority_mismatch_override",
        rule: assessment.rule,
        detail: "警告:ALLOW_DUAL_SURREAL_AUTHORITY_MISMATCH=true 已放行近空权威切换——首笔写将以 surreal 当前内容覆盖 sqlite 冷备。确认这是人工恢复的预期行为。",
        reason: assessment.reason,
        ...assessment.detail
      }));
    } else if (assessment.rule === "divergent") {
      // 规则 c(rule 一等字段分发,不解析 reason 文案/不比对截断 digest 反推):
      // 普通影子漂移保持"响亮但不熔断"的现状语义(镜像自愈 + shadow 健康度上报兜底)。
      console.warn(JSON.stringify({ event: "dual_surreal_shadow_divergence_at_startup", rule: assessment.rule, reason: assessment.reason, ...assessment.detail }));
    }
    repository = createDualWriteRepository({ authoritative: surreal, shadow: sqlite });
    console.warn(JSON.stringify({ event: "product_store", mode: "dual-surreal", detail: "surreal 权威 / sqlite 冷备" }));
  } else {
    // 默认:sqlite(不变;未知 PRODUCT_STORE 值已在 resolveProductStoreSelection 归一为 sqlite)。
    repository = createSqliteProductStateRepository({ dbPath: productStateDbPath });
  }
  // enableResearchScheduler: only the persistent process runs the background scheduler.
  // It self-gates per tick on systemConfig.research.autoScheduleEnabled (default off),
  // so users can toggle it on at runtime without a restart.
  const server = buildApiServer({
    productStateDbPath,
    productStateRepository: repository,
    // F-02/A2:把实际生效档位透出到 /api/system/capabilities,供 E2E globalSetup 校验隔离。
    productStoreMode: productStore,
    enableResearchScheduler: true
  });
  const port = Number(process.env.PORT ?? 3210);
  const host = process.env.HOST ?? "127.0.0.1";
  await server.listen({ host, port });

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
