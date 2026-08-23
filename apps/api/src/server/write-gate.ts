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
import { MEMORY_EXTRACT_TIMEOUT_MS } from "../intelligence/memory-extraction-llm";
import { FINALIZE_TIMEOUT_MS } from "../intelligence/finalize-llm";
import { COGNITIVE_RELATIONS_TIMEOUT_MS } from "../intelligence/cognitive-relations-llm";

// Global write serialization. Every mutating endpoint is a read-modify-write on the single
// shared ProductState with an await window in the middle (LLM / embedding / provider round-
// trips), and only PUT /api/state carries an optimistic-lock check. Without serialization two
// concurrent writes both read the same base snapshot and the second replaceState clobbers the
// first — a silently dropped session / memory candidate / audit event. This single chain makes
// every mutating request run one-at-a-time end-to-end. For a single-user local tool the
// throughput cost is negligible and it eliminates the lost-update class entirely (including the
// background research scheduler racing a user action). Reads (GET/HEAD/OPTIONS) are not gated.
export const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
// 写 slot 观测/自愈参数(真实业务 E2E 实测的死锁形态:某 mutating 请求的响应永不完成——客户端
// 中途断连/永挂 await——onResponse/onError 均不触发,slot 永久持有,所有后续写排队冻结,而读全部正常)。
export const WRITE_SLOT_WAIT_WARN_MS = 10_000;   // 等锁超过此时长开始点名持锁者(每 10s 一条,凶手 URL 直接进日志)
/** One embedding round-trip budget inside /end (theme attribution × 2 batches). */
export const END_EMBED_PHASE_MS = 15_000;
/** Slack so a legal /end is never force-released. */
export const WRITE_SLOT_HOLD_SLACK_MS = 30_000;
// Budget is derived from the live stage timeouts. Hard-coding 330s after extract/finalize
// were raised left a legal /end (450s worst-case) above the 360s hold — the P3-10
// invariant would not fire because the constant itself was stale.
export const END_WRITE_PHASE_BUDGET_MS =
  MEMORY_EXTRACT_TIMEOUT_MS +
  FINALIZE_TIMEOUT_MS +
  COGNITIVE_RELATIONS_TIMEOUT_MS +
  2 * END_EMBED_PHASE_MS;
export const WRITE_SLOT_MAX_HOLD_MS = END_WRITE_PHASE_BUDGET_MS + WRITE_SLOT_HOLD_SLACK_MS;
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
export interface WriteGateExemption {
  /** 限定 HTTP method;缺省 = 任意 mutating method。 */
  method?: string;
  /** 按 pathname 匹配(已剥 querystring)。 */
  matches: (pathname: string) => boolean;
  /** 为什么豁免是安全的(见上方统一语义;此处只记路由特有理由)。 */
  reason: string;
}
// prefix 必须以 "/" 结尾;仅匹配 prefix + 恰好一个非空段(其内不再含 "/")——即 `.../:id` 本身,
// 不匹配 `.../:id/子动作`。这把"未来同前缀慢 IO 子路由被自动豁免"的隐患挡在编译期之外。
export const idUnder = (prefix: string) => (p: string): boolean => {
  if (!p.startsWith(prefix)) return false;
  const rest = p.slice(prefix.length);
  return rest.length > 0 && !rest.includes("/");
};
export const WRITE_GATE_EXEMPTIONS: WriteGateExemption[] = [
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
    method: "POST",
    matches: (p) => p.startsWith("/api/podcast/episodes/") && p.endsWith("/confirm"),
    reason: "R3 试点:纯同步小 RMW,走 CAS(commit 经写门)"
  },
  {
    method: "POST",
    matches: (p) => p.startsWith("/api/podcast/episodes/") && p.endsWith("/synthesize"),
    reason: "TTS 锁外;终写=CAS 合并本条音频字段(commit 经写门)"
  },
  {
    method: "POST",
    matches: (p) => p === "/api/podcast/episodes",
    reason: "长 LLM;终写=CAS 追加本条(commit 经写门)。/:id/confirm 与 /synthesize 不命中本条"
  },
  {
    method: "DELETE",
    matches: idUnder("/api/podcast/episodes/"),
    reason: "R3 试点:纯同步小 RMW,走 CAS(commit 经写门)"
  },
  {
    method: "POST",
    matches: (p) => /^\/api\/notes\/[^/]+\/forget$/.test(p),
    reason: "终写=CAS 删热态(commit 经写门);冷层文件删在锁外尽力"
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
    // voice-instructions: embed/prefetch 在 handler 内;终写 re-read latest session 后
    // 仅 merge guide/card/enginePolicy(不覆盖 turns)。外呼慢 IO 不宜占全局写 slot。
    method: "POST",
    matches: (p) => p.startsWith("/api/interview-sessions/") && p.endsWith("/voice-instructions"),
    reason: "慢 embed+召回;终写=重读 latest 字段合并 guide/card(保 turns)"
  },
  {
    // SR-P1-03: HTTP 创建简报含外网 search + 可选 LLM enrich（可达数十秒）。
    // 终写经 writeGate.runExclusive 重读 latest 后 create（search.ts）。
    method: "POST",
    matches: (p) => p === "/api/search/briefs",
    reason: "长联网+enrich;终写=重读 latest 经写门(D3)"
  },
  {
    // SR-P1-03: 手动 refresh 同构（外网+enrich）；终写 merge + lastRefreshedAt 经写门。
    method: "POST",
    matches: (p) => p.startsWith("/api/search/briefs/") && p.endsWith("/refresh"),
    reason: "长联网+enrich;终写=重读 latest merge 经写门(D3)"
  },
  {
    // IM-P1-03: 导入抽取记忆 LLM 可达 60s；终写 ingest+durable 经写门。
    method: "POST",
    matches: (p) => p === "/api/import/documents",
    reason: "长 LLM 抽取;终写=重读 latest ingest 经写门(D3)"
  },
  {
    // IM-P1-03: chat embed+召回+LLM 可达数十秒；终写 append 双消息经写门。
    method: "POST",
    matches: (p) => p === "/api/chat",
    reason: "长 embed+LLM;终写=重读 latest append 经写门(D3)"
  },
  {
    // 主题/债一键出简报：外网+enrich 与 create/refresh 同构；终写重读 latest 只并入新 brief。
    method: "POST",
    matches: (p) => p === "/api/search/auto-briefs",
    reason: "长联网+enrich;终写=重读 latest 并入新简报经写门"
  },
  {
    // 语料分析 LLM 可达数十秒；终写重读 latest 再跑 analyzeImportedInterview。
    method: "POST",
    matches: (p) => p === "/api/corpus/insights",
    reason: "长 LLM 分析;终写=重读 latest 并入 insight/patch 经写门"
  },
  {
    // PR-6: login 只发 cookie，不碰 ProductState。挂在全局写槽后面会让别人收工时自己登不进去。
    method: "POST",
    matches: (p) => p === "/api/auth/login",
    reason: "无 state 终写(只发会话 cookie)，持锁无意义"
  },
  {
    method: "POST",
    matches: (p) => p === "/api/auth/logout",
    reason: "无 state 终写(清 cookie)，持锁无意义"
  },
  {
    // PR-2: 追问 LLM 可达十几秒。handler 不整段持槽；用户句/主持句终写走 runStateCommand CAS。
    method: "POST",
    matches: (p) => /^\/api\/interview-sessions\/[^/]+\/turns$/.test(p),
    reason: "长 LLM;终写=CAS 追加本场轮次(commit 经写门)"
  },
  {
    method: "POST",
    matches: (p) => /^\/api\/interview-sessions\/[^/]+\/turns\/stream$/.test(p),
    reason: "长 SSE LLM;终写=CAS 追加本场轮次(commit 经写门)"
  },
  {
    method: "POST",
    matches: (p) => /^\/api\/interview-sessions\/[^/]+\/turns\/cancel$/.test(p),
    reason: "取消在飞 LLM,自身无整态写;主持句由仍活着的 stream CAS 落库"
  },
  {
    // PR-6: 建场 embed/召回可达 15s。handler 不整段持槽；终写 CAS 追加一场会话。
    method: "POST",
    matches: (p) => p === "/api/interview-sessions",
    reason: "慢 embed+召回;终写=CAS 追加一场(commit 经写门)。/end 与 /turns 不命中本条"
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

export function registerWriteSerialization(server: ReturnType<typeof Fastify>): WriteGate {
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
