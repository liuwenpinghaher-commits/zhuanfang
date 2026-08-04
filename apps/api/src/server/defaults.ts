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


export function isSpaHistoryPath(pathname: string): boolean {
  const path = (pathname.split("?")[0] || "/").replace(/\/+$/, "") || "/";
  if (path.startsWith("/api")) return false;
  if (path.startsWith("/vad")) return false;
  if (path.startsWith("/assets")) return false;
  // Any remaining file extension → real static miss, not a history route.
  const base = path.split("/").pop() || "";
  if (base.includes(".") && !base.startsWith(".")) return false;
  return true;
}

export function createDefaultProductStateRepository() {
  return createInMemoryProductStateRepository();
}

export function createDefaultRawMaterialRepository() {
  return createInMemoryRawMaterialRepository();
}

export function createDefaultKnowledgeIndexRepository() {
  return createInMemoryKnowledgeIndexRepository();
}

export function createDefaultAudioRepository() {
  return createInMemoryAudioRepository();
}

/** N-10:给一个 promise 加超时——到点 reject(Error("<label> timeout"))。调用方 catch 后继续
 *  走关闭序列(绝不因某一步卡住而永不退出)。settle 后清 timer,不留悬挂计时器。 */
export function withDeadline<T>(p: Promise<T>, ms: number, label = "operation"): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

