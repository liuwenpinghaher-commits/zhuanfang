import Fastify from "fastify";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createSqliteProductStateRepository } from "../../../packages/db/src/sqlite-product-state-repository";
import { loadLocalEnvFile } from "./env";
import { createInMemoryProductStateRepository, type ProductStateRepository } from "./product-state-repository";
import { createAnySearchClientFromEnv, type AnySearchClient } from "./providers/anysearch";
import {
  createBailianAudioTranscriptionClientFromEnv,
  createBailianCharacterInterviewClientFromEnv,
  createBailianPodcastAudioClientFromEnv,
  createBailianRealtimeVoiceClientFromEnv,
  createBailianSearchClientFromEnv,
  type BailianAudioTranscriptionClient,
  type BailianCharacterInterviewClient,
  type BailianPodcastAudioClient,
  type BailianRealtimeVoiceClient,
  type BailianSearchClient
} from "./providers/bailian";
import { registerAssetRoutes } from "./routes/assets";
import { registerCorpusRoutes } from "./routes/corpus";
import { registerGeneratedArtifactRoutes } from "./routes/generated-artifacts";
import { registerHealthRoutes } from "./routes/health";
import { registerInterviewSessionRoutes } from "./routes/interview-sessions";
import { registerMastraRoutes } from "./routes/mastra";
import { registerMemoryCandidateRoutes } from "./routes/memory-candidates";
import { registerMemoryCorrectionRoutes } from "./routes/memory-corrections";
import { registerMemoryRecordRoutes } from "./routes/memory-records";
import { registerNoteRoutes } from "./routes/notes";
import { registerObservabilityRoutes } from "./routes/observability";
import { registerPlaybookPatchRoutes } from "./routes/playbook-patches";
import { registerPodcastRoutes } from "./routes/podcast";
import { registerProductConfigRoutes } from "./routes/product-config";
import { registerQualityRoutes } from "./routes/quality";
import { registerRealtimeVoiceRoutes } from "./routes/realtime-voice";
import { registerSearchRoutes } from "./routes/search";
import { registerStateRoutes } from "./routes/state";
import { registerSystemRoutes } from "./routes/system";

loadLocalEnvFile();

interface BuildApiServerOptions {
  productStateRepository?: ProductStateRepository;
  productStateDbPath?: string;
  bailianSearchClient?: BailianSearchClient;
  anySearchClient?: AnySearchClient;
  bailianPodcastAudioClient?: BailianPodcastAudioClient;
  bailianInterviewClient?: BailianCharacterInterviewClient;
  bailianRealtimeVoiceClient?: BailianRealtimeVoiceClient;
  bailianTranscriptionClient?: BailianAudioTranscriptionClient;
  env?: Record<string, string | undefined>;
  envFilePath?: string;
}

interface ProviderClients {
  bailianSearchClient?: BailianSearchClient;
  anySearchClient?: AnySearchClient;
  bailianPodcastAudioClient?: BailianPodcastAudioClient;
  bailianInterviewClient?: BailianCharacterInterviewClient;
  bailianRealtimeVoiceClient?: BailianRealtimeVoiceClient;
  bailianTranscriptionClient?: BailianAudioTranscriptionClient;
}

export function buildApiServer(options: BuildApiServerOptions = {}) {
  const server = Fastify({ logger: false });
  registerCors(server);
  const productStateRepository = options.productStateRepository ?? createDefaultProductStateRepository(options.productStateDbPath);
  const runtimeEnv = options.env ?? process.env;
  const providerClients: ProviderClients = {};
  const refreshProviderClients = () => refreshRuntimeProviderClients(providerClients, runtimeEnv, options);
  refreshProviderClients();
  const stateStore: "memory" | "sqlite" =
    options.productStateDbPath ?? runtimeEnv.PRODUCT_STATE_DB_PATH ? "sqlite" : "memory";
  const envFilePath = options.envFilePath ?? join(process.cwd(), ".env.local");

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
    await registerInterviewSessionRoutes(registeredServer, productStateRepository, providerClients);
  });
  void server.register(async (registeredServer) => {
    await registerSearchRoutes(registeredServer, productStateRepository, providerClients);
  });
  void server.register(async (registeredServer) => {
    await registerPodcastRoutes(registeredServer, productStateRepository, providerClients);
  });
  void server.register(async (registeredServer) => {
    await registerRealtimeVoiceRoutes(registeredServer, { bailianRealtimeVoiceClient: providerClients.bailianRealtimeVoiceClient, stateRepo: productStateRepository });
  });
  void server.register(async (registeredServer) => {
    await registerCorpusRoutes(registeredServer, productStateRepository, providerClients);
  });
  void server.register(async (registeredServer) => {
    await registerMemoryRecordRoutes(registeredServer, productStateRepository);
  });
  void server.register(async (registeredServer) => {
    await registerMemoryCandidateRoutes(registeredServer, productStateRepository);
  });
  void server.register(async (registeredServer) => {
    await registerMemoryCorrectionRoutes(registeredServer, productStateRepository);
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
    await registerMastraRoutes(registeredServer, productStateRepository);
  });
  void server.register(async (registeredServer) => {
    await registerProductConfigRoutes(registeredServer, productStateRepository);
  });
  void server.register(async (registeredServer) => {
    await registerGeneratedArtifactRoutes(registeredServer, productStateRepository);
  });
  void server.register(async (registeredServer) => {
    await registerQualityRoutes(registeredServer, productStateRepository);
  });
  void server.register(async (registeredServer) => {
    await registerObservabilityRoutes(registeredServer, productStateRepository);
  });
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
  providerClients.bailianRealtimeVoiceClient = options.bailianRealtimeVoiceClient ?? createBailianRealtimeVoiceClientFromEnv(env);
  providerClients.bailianTranscriptionClient =
    options.bailianTranscriptionClient ?? createBailianAudioTranscriptionClientFromEnv(env);
}

function registerCors(server: ReturnType<typeof Fastify>) {
  server.addHook("onRequest", async (request, reply) => {
    const origin = request.headers.origin;
    const allowedOrigin =
      origin === "http://127.0.0.1:5173" || origin === "http://localhost:5173" ? origin : "http://127.0.0.1:5173";

    reply.header("access-control-allow-origin", allowedOrigin);
    reply.header("access-control-allow-methods", "GET,POST,PUT,DELETE,OPTIONS");
    reply.header("access-control-allow-headers", "content-type,authorization");
    reply.header("access-control-max-age", "86400");

    if (request.method === "OPTIONS") {
      return reply.code(204).send();
    }
  });
}

function createDefaultProductStateRepository(dbPath = process.env.PRODUCT_STATE_DB_PATH) {
  if (dbPath) {
    return createSqliteProductStateRepository({ dbPath });
  }
  return createInMemoryProductStateRepository();
}

export async function startServer() {
  const server = buildApiServer();
  const port = Number(process.env.PORT ?? 8787);
  const host = process.env.HOST ?? "127.0.0.1";
  await server.listen({ host, port });
  return server;
}

export function isDirectCliExecution(importMetaUrl: string, argvEntry: string | undefined) {
  return Boolean(argvEntry) && importMetaUrl === pathToFileURL(argvEntry).href;
}

if (isDirectCliExecution(import.meta.url, process.argv[1])) {
  startServer().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
