// OpenTelemetry must be initialized before any other imports
import "./telemetry";

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
import { isAuthGuardActive, isAuthorized } from "./auth";
import { createLlmBudget } from "./llm-budget";
import { registerAssetRoutes } from "./routes/assets";
import { registerCorpusRoutes } from "./routes/corpus";
import { registerHealthRoutes } from "./routes/health";
import { registerImportRoutes } from "./routes/import";
import { registerInterviewSessionRoutes } from "./routes/interview-sessions";
import { registerMemoryRecordRoutes } from "./routes/memory-records";
import { registerMemoryCandidateRoutes } from "./routes/memory-candidates";
import { registerPlaybookPatchRoutes } from "./routes/playbook-patches";
import { registerPodcastRoutes } from "./routes/podcast";
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
  /**
   * Start the background research scheduler. Only the persistent process
   * (startServer) sets this; buildApiServer/tests leave it off so no timers leak.
   */
  enableResearchScheduler?: boolean;
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
  const server = Fastify({ logger: false, bodyLimit: REQUEST_BODY_LIMIT_BYTES });
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
  void server.register(async (registeredServer) => {
    await registerStateRoutes(registeredServer, productStateRepository, { env: runtimeEnv });
  });
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
      embeddingClient: providerClients.embeddingClient,
      streamingTtsClient: providerClients.streamingTtsClient,
      env: runtimeEnv
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
    // M3c: candidate approval embeds the new long-term record (semantic recall).
    // M5: consolidation (POST /api/memory/consolidate) reuses the chat client to
    // optionally summarize merged clusters into pending HITL candidates.
    await registerMemoryCandidateRoutes(registeredServer, productStateRepository, {
      embeddingClient: providerClients.embeddingClient,
      bailianChatClient: providerClients.bailianChatClient
    });
  });
  void server.register(async (registeredServer) => {
    await registerAssetRoutes(registeredServer, productStateRepository);
  });
  void server.register(async (registeredServer) => {
    await registerPlaybookPatchRoutes(registeredServer, productStateRepository);
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
      intervalMs: (research?.scheduleIntervalMin ?? 1440) * 60 * 1000
    });
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

    if (isAuthorized(env, { authHeader: request.headers.authorization })) {
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
  // enableResearchScheduler: only the persistent process runs the background scheduler.
  // It self-gates per tick on systemConfig.research.autoScheduleEnabled (default off),
  // so users can toggle it on at runtime without a restart.
  const server = buildApiServer({
    productStateDbPath,
    productStateRepository: repository,
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
