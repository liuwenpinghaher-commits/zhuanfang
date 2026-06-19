// OpenTelemetry must be initialized before any other imports
import "./telemetry";

import { timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyRequest, type FastifyReply } from "fastify";
import fastifyStatic from "@fastify/static";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createSqliteProductStateRepository } from "../../../packages/db/src/sqlite-product-state-repository";
import { loadLocalEnvFile } from "./env";
import { createInMemoryProductStateRepository, type ProductStateRepository } from "./product-state-repository";
import { createAnySearchClientFromEnv, type AnySearchClient } from "./providers/anysearch";
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
import { createLlmBudget } from "./llm-budget";
import { registerAssetRoutes } from "./routes/assets";
import { registerCorpusRoutes } from "./routes/corpus";
import { registerGeneratedArtifactRoutes } from "./routes/generated-artifacts";
import { registerHealthRoutes } from "./routes/health";
import { registerImportRoutes } from "./routes/import";
import { registerInterviewSessionRoutes } from "./routes/interview-sessions";
import { registerMemoryRecordRoutes } from "./routes/memory-records";
import { registerMemoryCandidateRoutes } from "./routes/memory-candidates";
import { registerNoteRoutes } from "./routes/notes";
import { registerPlaybookPatchRoutes } from "./routes/playbook-patches";
import { registerPodcastRoutes } from "./routes/podcast";
import { registerQualityRoutes } from "./routes/quality";
import { registerRagRoutes } from "./routes/rag";
import { registerRealtimeVoiceRoutes } from "./routes/realtime-voice";
import { registerReviewRoutes } from "./routes/reviews";
import { registerSearchRoutes } from "./routes/search";
import { startResearchScheduler } from "./research-scheduler";
import { registerStateRoutes } from "./routes/state";
import { registerSystemRoutes } from "./routes/system";

interface BuildApiServerOptions {
  productStateRepository?: ProductStateRepository;
  productStateDbPath?: string;
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

export function buildApiServer(options: BuildApiServerOptions = {}) {
  const server = Fastify({ logger: false });
  const runtimeEnv = options.env ?? process.env;
  registerCors(server, runtimeEnv);
  registerProductionAuth(server, runtimeEnv);
  const productStateRepository = options.productStateRepository ?? createDefaultProductStateRepository(options.productStateDbPath);
  const providerClients: ProviderClients = {};
  const refreshProviderClients = () => refreshRuntimeProviderClients(providerClients, runtimeEnv, options);
  refreshProviderClients();
  const effectiveDbPath = options.productStateDbPath ?? runtimeEnv.PRODUCT_STATE_DB_PATH;
  const stateStore: "memory" | "sqlite" =
    effectiveDbPath && !isInMemoryDbPath(effectiveDbPath) ? "sqlite" : "memory";
  const envFilePath = options.envFilePath ?? join(process.cwd(), ".env.local");

  // Single shared budget instance — covers all LLM entry points (interview turns,
  // pre-signals, corpus insights, reviews, import, search enrichment, podcast script).
  // Uses "system" key for non-session endpoints and session.id for session endpoints.
  const sharedBudget = createLlmBudget();

  void server.register(registerHealthRoutes);
  void server.register(async (registeredServer) => {
    await registerSystemRoutes(registeredServer, productStateRepository, {
      stateStore,
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
  void server.register(registerStateRoutes, productStateRepository);
  void server.register(async (registeredServer) => {
    await registerInterviewSessionRoutes(registeredServer, productStateRepository, {
      ...providerClients,
      llmBudget: sharedBudget
    });
  });
  void server.register(async (registeredServer) => {
    await registerSearchRoutes(registeredServer, productStateRepository, {
      ...providerClients,
      llmBudget: sharedBudget
    });
  });
  void server.register(async (registeredServer) => {
    await registerPodcastRoutes(registeredServer, productStateRepository, {
      ...providerClients,
      llmBudget: sharedBudget
    });
  });
  void server.register(async (registeredServer) => {
    await registerRealtimeVoiceRoutes(registeredServer, {
      bailianRealtimeVoiceClient: providerClients.bailianRealtimeVoiceClient,
      voiceEnrollmentClient: providerClients.voiceEnrollmentClient,
      stateRepo: productStateRepository,
      streamingTtsClient: providerClients.streamingTtsClient
    });
  });
  void server.register(async (registeredServer) => {
    await registerCorpusRoutes(registeredServer, productStateRepository, {
      ...providerClients,
      llmBudget: sharedBudget
    });
  });
  void server.register(async (registeredServer) => {
    await registerReviewRoutes(registeredServer, productStateRepository, {
      ...providerClients,
      llmBudget: sharedBudget
    });
  });
  void server.register(async (registeredServer) => {
    await registerImportRoutes(registeredServer, productStateRepository, {
      ...providerClients,
      llmBudget: sharedBudget
    });
  });
  void server.register(async (registeredServer) => {
    await registerMemoryRecordRoutes(registeredServer, productStateRepository);
  });
  void server.register(async (registeredServer) => {
    await registerMemoryCandidateRoutes(registeredServer, productStateRepository);
  });
  void server.register(async (registeredServer) => {
    await registerNoteRoutes(registeredServer, productStateRepository);
  });
  void server.register(async (registeredServer) => {
    await registerAssetRoutes(registeredServer, productStateRepository);
  });
  void server.register(async (registeredServer) => {
    await registerPlaybookPatchRoutes(registeredServer, productStateRepository);
  });
  void server.register(async (registeredServer) => {
    await registerGeneratedArtifactRoutes(registeredServer, productStateRepository);
  });
  void server.register(async (registeredServer) => {
    await registerQualityRoutes(registeredServer, productStateRepository);
  });
  void server.register(async (registeredServer) => {
    await registerRagRoutes(registeredServer, productStateRepository, {
      ...providerClients,
      llmBudget: sharedBudget
    });
  });

  // Static file serving: when PRODUCT_STATIC_DIR is set (production Docker image),
  // serve the built frontend from that directory. Registered after all API routes
  // so /api/* handlers take precedence.
  const staticDir = runtimeEnv.PRODUCT_STATIC_DIR;
  if (staticDir) {
    void server.register(fastifyStatic, { root: staticDir });
  }

  return server;
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
  providerClients.embeddingClient =
    options.embeddingClient ?? createBailianEmbeddingClientFromEnv(env) ?? undefined;
  // Streaming TTS client for the TTS WebSocket proxy (browser ↔ CosyVoice).
  // If no API key is configured, the proxy will reject upgrades with 4001 at
  // connect time — safe to leave undefined here.
  const ttsApiKey = env.DASHSCOPE_API_KEY ?? env.BAILIAN_API_KEY;
  providerClients.streamingTtsClient =
    options.streamingTtsClient ??
    (ttsApiKey ? createBailianStreamingTtsClient({ apiKey: ttsApiKey }) : undefined);
}

function registerCors(server: ReturnType<typeof Fastify>, env: Record<string, string | undefined>) {
  // Build the allowed origins set. PRODUCT_WEB_ORIGINS is a comma-separated list
  // of production origins (e.g. "https://app.example.com"). When absent, fall back
  // to the Vite dev-server origins so local development stays zero-friction.
  const extraOrigins = env.PRODUCT_WEB_ORIGINS
    ? new Set(env.PRODUCT_WEB_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean))
    : null;

  const devOrigins = new Set(["http://127.0.0.1:5173", "http://localhost:5173"]);

  server.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    const origin = request.headers.origin;

    let allowedOrigin: string | undefined;
    if (origin) {
      const allowedSet = extraOrigins ?? devOrigins;
      if (allowedSet.has(origin)) {
        allowedOrigin = origin;
      } else if (!extraOrigins) {
        // No PRODUCT_WEB_ORIGINS configured — keep old fallback for dev
        allowedOrigin = "http://127.0.0.1:5173";
      }
    }

    if (allowedOrigin) {
      reply.header("access-control-allow-origin", allowedOrigin);
    }
    reply.header("access-control-allow-methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    reply.header("access-control-allow-headers", "content-type,authorization");
    reply.header("access-control-max-age", "86400");

    if (request.method === "OPTIONS") {
      return reply.code(204).send();
    }
  });
}

// Paths exempted from bearer auth in production profile (healthcheck, metrics, etc.)
const AUTH_EXEMPT_PREFIXES = ["/api/health"];

function registerProductionAuth(server: ReturnType<typeof Fastify>, env: Record<string, string | undefined>) {
  // Case-insensitive comparison prevents "Production"/"PRODUCTION" silently bypassing auth (fix: P0-5)
  const isProduction = (env.DEPLOYMENT_PROFILE ?? "").trim().toLowerCase() === "production";
  const apiToken = env.PRODUCT_API_TOKEN;

  // Auth guard is only active when both conditions hold: production profile AND a token configured.
  // This keeps local development completely friction-free.
  if (!isProduction || !apiToken) {
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

    const authHeader = request.headers.authorization;
    // Timing-safe comparison prevents timing-oracle attacks on the bearer token (fix: P0-5)
    const expected = `Bearer ${apiToken}`;
    const actual = authHeader ?? "";
    const expectedBuf = Buffer.from(expected);
    const actualBuf = Buffer.from(actual.padEnd(expected.length, "\0").slice(0, expected.length));
    if (actual.length === expected.length && timingSafeEqual(expectedBuf, actualBuf)) {
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

function isInMemoryDbPath(dbPath: string) {
  const normalized = dbPath.trim().toLowerCase();
  return normalized === "memory" || normalized === ":memory:" || normalized === "in-memory";
}

export async function startServer() {
  loadLocalEnvFile();
  // Persist by default so a server restart no longer drops all interview state.
  // Tests call buildApiServer() directly (no dbPath) and stay in-memory/isolated.
  const productStateDbPath = process.env.PRODUCT_STATE_DB_PATH ?? join(process.cwd(), ".data", "product-state.db");

  const repository = createSqliteProductStateRepository({ dbPath: productStateDbPath });
  const server = buildApiServer({ productStateDbPath, productStateRepository: repository });
  const port = Number(process.env.PORT ?? 8787);
  const host = process.env.HOST ?? "127.0.0.1";
  await server.listen({ host, port });

  // 后台调研调度器：仅在常驻进程（startServer）中启动，buildApiServer/测试不触发。
  // 默认关闭（autoScheduleEnabled: false）；在 systemConfig.research.autoScheduleEnabled
  // 设为 true 后，重启服务即激活。非常驻环境靠 POST /api/research/auto-run 手动触发。
  const researchConfig = repository.getState().systemConfig.research;
  const schedulerEnabled = researchConfig?.autoScheduleEnabled ?? false;
  const schedulerIntervalMin = researchConfig?.scheduleIntervalMin ?? 1440;
  startResearchScheduler({
    repository,
    clients: {}, // provider clients 在运行时从 env 注入；调度器默认降级 local-demo
    intervalMs: schedulerIntervalMin * 60 * 1000,
    enabled: schedulerEnabled
  });

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
