/** Split from server.ts — graceful shutdown sequence. */
import { shutdownTelemetry } from "../telemetry";
import { withDeadline } from "./defaults";

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

