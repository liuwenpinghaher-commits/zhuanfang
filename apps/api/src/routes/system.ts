import type { FastifyInstance } from "fastify";
import {
  BAILIAN_PODCAST_TTS_MODEL,
  BAILIAN_PODCAST_TTS_VOICE,
  BAILIAN_REALTIME_FALLBACK_MODEL,
  BAILIAN_REALTIME_MODEL,
  BAILIAN_REALTIME_DEFAULT_VOICE,
  resolveBailianRealtimeModels,
  BAILIAN_ROLE_PLAY_MODEL,
  BAILIAN_TRANSCRIPTION_MODEL,
  BAILIAN_LATEST_PLUS_MODEL
} from "../providers/bailian";
import type { AnySearchClient } from "../providers/anysearch";

import { COSYVOICE_PRESET_VOICES } from "../voice-presets";
import type {
  BailianAudioTranscriptionClient,
  BailianCharacterInterviewClient,
  BailianPodcastAudioClient,
  BailianRealtimeVoiceClient,
  BailianSearchClient
} from "../providers/bailian";
import { writeEnvFileUpdates, type RuntimeEnv } from "../env";
import { getRuntimeMetricsSnapshot } from "../observability/runtime-metrics";
import type { ProductStateRepository } from "../product-state-repository";
import { normalizeConfiguredSecret, resolveBailianApiKey } from "../runtime-secrets";

type CapabilityStatus = "ready" | "degraded" | "needs-key" | "needs-endpoint" | "disabled";
type CapabilityKind = "runtime" | "storage" | "search" | "llm" | "voice";

interface SystemCapability {
  id: string;
  kind: CapabilityKind;
  label: string;
  status: CapabilityStatus;
  active: boolean;
  detail: string;
  requiredEnv: string[];
  model?: string;
  transport?: string;
  configured?: boolean;
  availability?: "unknown" | "available" | "unavailable";
  lastErrorCode?: string;
  lastCheckedAt: string;
}

interface SystemRouteOptions {
  // R7:持久档从 sqlite 换成 surreal(唯一持久档);memory 为不持久档。
  stateStore: "memory" | "surreal";
  /** 审计修复(P3-47):真实权威库档位(memory|surreal)。R7 后与 stateStore 同值,保留字段避免改动透出契约。 */
  productStore?: string;
  env?: RuntimeEnv;
  envFilePath?: string;
  refreshProviderClients?: () => void;
  bailianSearchClient?: BailianSearchClient;
  anySearchClient?: AnySearchClient;
  bailianPodcastAudioClient?: BailianPodcastAudioClient;
  bailianInterviewClient?: BailianCharacterInterviewClient;
  bailianRealtimeVoiceClient?: BailianRealtimeVoiceClient;
  bailianTranscriptionClient?: BailianAudioTranscriptionClient;
  /** Stage-2: optional embedding readiness (cloud or local). */
  embeddingConfigured?: boolean;
  /** Optional LLM budget snapshot getter. */
  getLlmBudgetRemaining?: () => number | undefined;
}

type ConfigSectionId = "secrets" | "models" | "search" | "voice" | "storage";
type ConfigValueKind = "secret" | "string" | "number" | "boolean" | "select";

interface RuntimeSettingDefinition {
  key: string;
  section: ConfigSectionId;
  label: string;
  description: string;
  valueKind: ConfigValueKind;
  secret?: boolean;
  required?: boolean;
  defaultValue?: string;
  options?: Array<{ label: string; value: string }>;
  restartRequired?: boolean;
}

interface RuntimeConfigPayload {
  updates?: unknown;
}

const runtimeSettingDefinitions: RuntimeSettingDefinition[] = [
  {
    key: "DASHSCOPE_API_KEY",
    section: "secrets",
    label: "DashScope / 百炼 API Key",
    description: "百炼联网搜索、角色扮演、CosyVoice、SenseVoice 和 Realtime 的主密钥。",
    valueKind: "secret",
    secret: true,
    required: true
  },
  {
    key: "BAILIAN_API_KEY",
    section: "secrets",
    label: "百炼备用 API Key",
    description: "DASHSCOPE_API_KEY 未配置时使用的备用 key。",
    valueKind: "secret",
    secret: true
  },
  {
    key: "BAILIAN_EMBEDDING_API_KEY",
    section: "secrets",
    label: "Embeddings 专用 Key",
    description: "只用于记忆检索向量。不要填聊天/语音那把 token-plan 钥。",
    valueKind: "secret",
    secret: true
  },
  {
    key: "BAILIAN_EMBEDDING_BASE_URL",
    section: "models",
    label: "Embeddings 接口地址",
    description: "DashScope compatible-mode embeddings 端点。",
    valueKind: "string",
    defaultValue: "https://dashscope.aliyuncs.com/compatible-mode/v1"
  },
  {
    key: "BAILIAN_EMBEDDING_MODEL",
    section: "models",
    label: "Embeddings 模型",
    description: "记忆检索用的向量模型。",
    valueKind: "string",
    defaultValue: "text-embedding-v3"
  },
  {
    key: "EMBEDDING_PROVIDER",
    section: "models",
    label: "记忆检索方式",
    description: "local=服务器本地中文向量模型，不需要云端检索钥匙。空=云端向量（要 embeddings 专用钥）。",
    valueKind: "select",
    options: [
      { label: "云端向量", value: "" },
      { label: "服务器本地", value: "local" }
    ]
  },
  {
    key: "ANYSEARCH_API_KEY",
    section: "secrets",
    label: "AnySearch API Key",
    description: "外接 AnySearch 搜索 provider 的服务端 key。",
    valueKind: "secret",
    secret: true
  },
  {
    key: "BAILIAN_SEARCH_MODEL",
    section: "models",
    label: "联网搜索模型",
    description: "用于百炼 Responses 内置联网搜索和素材提炼。",
    valueKind: "string",
    defaultValue: BAILIAN_LATEST_PLUS_MODEL
  },
  {
    key: "BAILIAN_CHARACTER_MODEL",
    section: "models",
    label: "角色扮演专访模型",
    description: "用于文本专访中的自然主持追问。",
    valueKind: "string",
    defaultValue: BAILIAN_ROLE_PLAY_MODEL
  },
  {
    key: "BAILIAN_TTS_MODEL",
    section: "models",
    label: "播客 TTS 模型",
    description: "用于把播客脚本渲染为真实音频。",
    valueKind: "string",
    defaultValue: BAILIAN_PODCAST_TTS_MODEL
  },
  {
    key: "BAILIAN_ASR_MODEL",
    section: "models",
    label: "音频转写模型",
    description: "用于导入音频专访时生成转写稿。",
    valueKind: "string",
    defaultValue: BAILIAN_TRANSCRIPTION_MODEL
  },
  {
    key: "BAILIAN_REALTIME_MODEL",
    section: "models",
    label: "双向实时语音模型",
    description: "用于沉浸式实时专访的 Qwen-Omni Realtime 模型。",
    valueKind: "string",
    defaultValue: BAILIAN_REALTIME_MODEL
  },
  {
    key: "BAILIAN_REALTIME_FALLBACK_MODEL",
    section: "models",
    label: "双向实时语音备用模型",
    description: "主模型在 ready 前被拒绝或握手超时时仅尝试一次的备用 Realtime 模型。",
    valueKind: "string",
    defaultValue: BAILIAN_REALTIME_FALLBACK_MODEL
  },
  {
    key: "BAILIAN_BASE_URL",
    section: "models",
    label: "百炼兼容模式 Base URL",
    description: "联网搜索和角色扮演 Chat/Responses API 的服务端地址。",
    valueKind: "string",
    defaultValue: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1"
  },
  {
    key: "BAILIAN_AUDIO_BASE_URL",
    section: "models",
    label: "百炼音频 Base URL",
    description: "Qwen-Audio TTS 与异步转写任务的服务端地址。",
    valueKind: "string",
    defaultValue: "https://token-plan.cn-beijing.maas.aliyuncs.com"
  },
  {
    key: "ANYSEARCH_ALLOW_ANONYMOUS",
    section: "search",
    label: "允许 AnySearch 匿名模式",
    description: "未配置 AnySearch key 时是否显式使用匿名模式。",
    valueKind: "boolean",
    defaultValue: "false"
  },
  {
    key: "ANYSEARCH_BASE_URL",
    section: "search",
    label: "AnySearch Base URL",
    description: "外接搜索 provider 的 API 地址。",
    valueKind: "string",
    defaultValue: "https://api.anysearch.com"
  },
  {
    key: "ANYSEARCH_LANGUAGE",
    section: "search",
    label: "AnySearch 语言",
    description: "搜索结果语言偏好。",
    valueKind: "string",
    defaultValue: "zh-CN"
  },
  {
    key: "ANYSEARCH_ZONE",
    section: "search",
    label: "AnySearch 区域",
    description: "搜索区域偏好。",
    valueKind: "select",
    options: [
      { label: "自动", value: "" },
      { label: "中国区", value: "cn" },
      { label: "国际区", value: "intl" }
    ]
  },
  {
    key: "BAILIAN_TTS_VOICE",
    section: "voice",
    label: "播客默认音色",
    description: "播客 / 级联合成使用的音色。",
    valueKind: "select",
    defaultValue: BAILIAN_PODCAST_TTS_VOICE,
    options: COSYVOICE_PRESET_VOICES.map((v) => ({ label: `${v.name} (${v.voice})`, value: v.voice }))
  },
  {
    key: "BAILIAN_ASR_LANGUAGE_HINT",
    section: "voice",
    label: "音频转写语言提示",
    description: "语音识别语言提示，通常使用 zh 或 auto。",
    valueKind: "string",
    defaultValue: "zh"
  },
  {
    key: "BAILIAN_ASR_POLL_ATTEMPTS",
    section: "voice",
    label: "ASR 轮询次数",
    description: "服务端最多查询转写任务状态的次数。",
    valueKind: "number",
    defaultValue: "20"
  },
  {
    key: "BAILIAN_ASR_POLL_INTERVAL_MS",
    section: "voice",
    label: "ASR 轮询间隔",
    description: "服务端查询转写任务状态的间隔毫秒数。",
    valueKind: "number",
    defaultValue: "500"
  },
  {
    key: "BAILIAN_REALTIME_WEBRTC_ENDPOINT",
    section: "voice",
    label: "Realtime WebRTC Endpoint",
    description: "实时语音 WebRTC SDP 代理 endpoint。",
    valueKind: "string",
    required: true
  },
  {
    key: "BAILIAN_REALTIME_TRANSPORT",
    section: "voice",
    label: "Realtime 传输方式",
    description: "WebSocket 无需白名单，WebRTC 需要白名单 Endpoint。",
    valueKind: "select",
    defaultValue: "websocket",
    options: [
      { label: "WebRTC", value: "webrtc" },
      { label: "WebSocket", value: "websocket" }
    ]
  },
  {
    key: "BAILIAN_REALTIME_VOICE",
    section: "voice",
    label: "Realtime 音色",
    description: "实时语音对话使用的音色。可通过声音复刻创建自定义音色。",
    valueKind: "select",
    defaultValue: BAILIAN_REALTIME_DEFAULT_VOICE,
    options: [
      { label: "龙安聆心", value: "longanlingxin" },
      { label: "龙安谦", value: "longanqian" },
      { label: "龙安灵犀", value: "longanlingxi" },
      { label: "龙安小新", value: "longanxiaoxin" },
      { label: "龙安陆风", value: "longanlufeng" }
    ]
  },
  {
    key: "BAILIAN_REALTIME_ENABLE_SEARCH",
    section: "voice",
    label: "Realtime 启用联网材料",
    description: "实时专访 session.update 中是否允许携带联网材料能力。",
    valueKind: "boolean",
    defaultValue: "false"
  },
  {
    key: "PRODUCT_STATE_DB_PATH",
    section: "storage",
    label: "Product State DB Path",
    // P3-06:R7 后持久档是嵌入式 SurrealDB(surrealkv),数据目录建在该路径旁的 .../surreal;
    // 设为 memory 则用内存档(重启回 seed)。此前文案沿用旧"SQLite 状态库",与现实不符。
    description: "SurrealDB 数据目录基准路径(在其旁建 surreal/ 目录持久化);设为 memory 用内存档。修改后需重启 API 生效。",
    valueKind: "string",
    restartRequired: true
  }
];

const configSectionLabels: Record<ConfigSectionId, string> = {
  secrets: "密钥",
  models: "模型",
  search: "联网搜索",
  voice: "语音与实时",
  storage: "存储"
};

export async function registerSystemRoutes(
  server: FastifyInstance,
  repository: ProductStateRepository,
  options: SystemRouteOptions
) {
  server.get("/api/system/config", async () => {
    return buildRuntimeConfigResponse(options);
  });

  server.patch("/api/system/config", async (request, reply) => {
    const updates = normalizeRuntimeConfigUpdates(request.body);
    if (Object.keys(updates).length === 0) {
      return reply.code(422).send({ error: "At least one supported config update is required." });
    }

    // Refuse to silently clear a REQUIRED secret (e.g. DASHSCOPE_API_KEY) — doing so would
    // degrade every dependent capability without any explicit signal.
    const requiredSecretKeys = new Set(
      runtimeSettingDefinitions.filter((definition) => definition.required && definition.secret).map((definition) => definition.key)
    );
    const clearedRequired = Object.entries(updates)
      .filter(([key, value]) => value === undefined && requiredSecretKeys.has(key))
      .map(([key]) => key);
    if (clearedRequired.length > 0) {
      return reply.code(422).send({ error: `不能清空必填密钥：${clearedRequired.join("、")}。如需更换请直接填入新值。` });
    }

    const env = options.env ?? process.env;
    if (options.envFilePath) {
      writeEnvFileUpdates(options.envFilePath, updates);
    }
    for (const [key, value] of Object.entries(updates)) {
      if (value === undefined) {
        delete env[key];
        if (!options.env) {
          delete process.env[key];
        }
      } else {
        env[key] = value;
        if (!options.env) {
          process.env[key] = value;
        }
      }
    }
    options.refreshProviderClients?.();

    return {
      settingsUpdated: Object.keys(updates),
      config: buildRuntimeConfigResponse(options)
    };
  });

  server.get("/api/system/capabilities", async () => {
    const state = repository.getState();
    const env = options.env ?? process.env;
    const generatedAt = new Date().toISOString();
    const bailianApiKey = resolveBailianApiKey(env);
    const dashscopeKeyConfigured = Boolean(bailianApiKey);
    const anySearchKeyConfigured = Boolean(normalizeConfiguredSecret(env.ANYSEARCH_API_KEY));
    const anySearchAnonymous = env.ANYSEARCH_ALLOW_ANONYMOUS === "true";
    const anySearchAvailability = options.anySearchClient?.getAvailability?.() ?? { status: "unknown" as const };
    const realtimeEndpointConfigured = true; // default public DashScope WebRTC; BAILIAN_REALTIME_WEBRTC_ENDPOINT optional override
    const realtimeTransport = env.BAILIAN_REALTIME_TRANSPORT === "webrtc" ? "webrtc" : "websocket";

    const realtimeModels = resolveBailianRealtimeModels(env);
    const capabilities: SystemCapability[] = [
      {
        id: "product-api",
        kind: "runtime",
        label: "Product API",
        status: "ready",
        active: true,
        detail: "Fastify Product API 正在运行，前端所有外部能力都通过该服务代理。",
        requiredEnv: [],
        lastCheckedAt: generatedAt
      },
      {
        id: "state-store",
        kind: "storage",
        // P3-06:Memory mode works but is NOT persistent — surface it as degraded (not the same
        // green "ready" as the durable SurrealDB store). PRODUCT_STATE_DB_PATH 有默认值
        // (.data/product-state.db 旁建 surreal/),并非必填 → requiredEnv 不再列它(旧文案误标必需)。
        label: "Product State Store",
        // R7:持久 = surreal 档;非 memory 即持久(唯一持久档为 SurrealDB 嵌入式 surrealkv)。
        status: options.stateStore !== "memory" ? "ready" : "degraded",
        active: true,
        detail: options.stateStore !== "memory"
          ? "SurrealDB 状态库已启用（嵌入式 surrealkv，图/向量/混合检索生效），数据持久化。"
          : "内存状态库已启用：数据不持久，重启后回到 seed 状态；导出仅为当前会话快照。",
        requiredEnv: [],
        lastCheckedAt: generatedAt
      },
      {
        id: "bailian-responses",
        kind: "search",
        label: "百炼 Responses 内置联网",
        status: options.bailianSearchClient ? "ready" : "needs-key",
        active: state.systemConfig.search.activeProvider === "bailian",
        detail: options.bailianSearchClient
          ? "已通过服务端 key 配置，可调用 token-plan 文本模型 Responses web_search / web_extractor。"
          : "缺少 DASHSCOPE_API_KEY 或 BAILIAN_API_KEY，百炼联网搜索会降级。",
        requiredEnv: ["DASHSCOPE_API_KEY"],
        model: env.BAILIAN_SEARCH_MODEL ?? BAILIAN_LATEST_PLUS_MODEL,
        lastCheckedAt: generatedAt
      },
      {
        id: "anysearch",
        kind: "search",
        label: "AnySearch",
        status: !options.anySearchClient
          ? "needs-key"
          : anySearchAvailability.status === "available"
            ? "ready"
            : "degraded",
        active: state.systemConfig.search.activeProvider === "anysearch",
        detail: !options.anySearchClient
          ? "ANYSEARCH_API_KEY 未配置，AnySearch 将降级为本地可复核素材。"
          : anySearchAvailability.status === "available"
            ? "AnySearch 已配置，且最近一次真实请求成功。"
            : anySearchAvailability.status === "unavailable"
              ? `AnySearch 已配置，但最近一次真实请求失败（${anySearchAvailability.lastErrorCode ?? "request_error"}）。`
              : anySearchKeyConfigured
                ? "AnySearch API Key 已配置，但尚未经过真实请求验证。"
                : "AnySearch 匿名模式已启用，但尚未经过真实请求验证。",
        requiredEnv: anySearchAnonymous ? ["ANYSEARCH_ALLOW_ANONYMOUS"] : ["ANYSEARCH_API_KEY"],
        configured: Boolean(options.anySearchClient),
        availability: options.anySearchClient ? anySearchAvailability.status : "unavailable",
        ...(anySearchAvailability.lastErrorCode ? { lastErrorCode: anySearchAvailability.lastErrorCode } : {}),
        lastCheckedAt: anySearchAvailability.lastCheckedAt ?? generatedAt
      },
      {
        id: "bailian-cosyvoice",
        kind: "voice",
        label: "Qwen-Audio 播客 TTS",
        status: options.bailianPodcastAudioClient ? "ready" : "needs-key",
        active: state.systemConfig.voice.ttsProvider === "bailian",
        detail: options.bailianPodcastAudioClient
          ? "已配置服务端 TTS provider，播客脚本会渲染为真实音频 URL。"
          : "缺少 DASHSCOPE_API_KEY 或 BAILIAN_API_KEY，播客将保留本地占位音频。",
        requiredEnv: ["DASHSCOPE_API_KEY"],
        model: env.BAILIAN_TTS_MODEL ?? BAILIAN_PODCAST_TTS_MODEL,
        lastCheckedAt: generatedAt
      },
      {
        id: "bailian-sensevoice",
        kind: "voice",
        label: "Qwen-Audio 录音转写",
        status: options.bailianTranscriptionClient ? "ready" : "needs-key",
        active: true,
        detail: options.bailianTranscriptionClient
          ? "已配置语音识别：公网 URL 可直接转写；本地上传需 CORPUS_AUDIO_PUBLIC_BASE_URL（见 env；未配置则落盘后诚实 422）。"
          : "缺少 DASHSCOPE_API_KEY 或 BAILIAN_API_KEY，音频导入会要求人工转写稿。",
        requiredEnv: ["DASHSCOPE_API_KEY"],
        model: env.BAILIAN_ASR_MODEL ?? BAILIAN_TRANSCRIPTION_MODEL,
        transport: "async-task",
        lastCheckedAt: generatedAt
      },
      {
        id: "bailian-character",
        kind: "llm",
        label: "百炼角色扮演专访",
        status: options.bailianInterviewClient ? "ready" : "needs-key",
        active: Boolean(state.systemConfig.models.interviewModel),
        detail: options.bailianInterviewClient
          ? "已配置文本专访模型，可走 token-plan 追问。"
          : "缺少 DASHSCOPE_API_KEY 或 BAILIAN_API_KEY，文本专访无法调用角色扮演模型（接口 fail-loud 返回 5xx，不会用本地模板冒充 AI 追问）。",
        requiredEnv: ["DASHSCOPE_API_KEY"],
        model: env.BAILIAN_CHARACTER_MODEL ?? BAILIAN_ROLE_PLAY_MODEL,
        lastCheckedAt: generatedAt
      },
      {
        id: "embedding",
        kind: "llm",
        label: "向量嵌入（记忆/知识召回）",
        status: (env.EMBEDDING_PROVIDER ?? "").trim().toLowerCase() === "local"
          || Boolean((env.BAILIAN_EMBEDDING_API_KEY ?? env.DASHSCOPE_EMBEDDING_API_KEY ?? "").trim())
          || options.embeddingConfigured
          ? "ready"
          : "needs-key",
        active: true,
        detail: (env.EMBEDDING_PROVIDER ?? "").trim().toLowerCase() === "local"
          ? "本地 embedding（EMBEDDING_PROVIDER=local）已启用。"
          : (env.BAILIAN_EMBEDDING_API_KEY ?? env.DASHSCOPE_EMBEDDING_API_KEY ?? "").trim()
            ? "已配置 embeddings 专用钥。"
            : "未配置 embeddings 专用钥：记忆检索走关键词，不影响开场。",
        requiredEnv: (env.EMBEDDING_PROVIDER ?? "").trim().toLowerCase() === "local"
          ? ["EMBEDDING_PROVIDER"]
          : ["BAILIAN_EMBEDDING_API_KEY"],
        lastCheckedAt: generatedAt
      },
      {
        id: "corpus-audio-public",
        kind: "voice",
        label: "语料本地音频公开基址",
        status: (env.CORPUS_AUDIO_PUBLIC_BASE_URL ?? "").trim() ? "ready" : "degraded",
        active: Boolean((env.CORPUS_AUDIO_PUBLIC_BASE_URL ?? "").trim()),
        detail: (env.CORPUS_AUDIO_PUBLIC_BASE_URL ?? "").trim()
          ? `本地上传可映射到公开 URL 后走 SenseVoice：${(env.CORPUS_AUDIO_PUBLIC_BASE_URL ?? "").trim()}`
          : "未配置 CORPUS_AUDIO_PUBLIC_BASE_URL：本地音频会落盘并诚实 422；公网 URL 仍可转写。",
        requiredEnv: ["CORPUS_AUDIO_PUBLIC_BASE_URL"],
        lastCheckedAt: generatedAt
      },
      {
        id: "corpus-audio-presign",
        kind: "voice",
        label: "语料预签名上传",
        status: "ready",
        active: true,
        detail: (env.CORPUS_S3_BUCKET ?? "").trim() && (env.AWS_ACCESS_KEY_ID ?? env.CORPUS_S3_ACCESS_KEY_ID ?? "").trim()
          ? `S3 预签名已启用（bucket=${(env.CORPUS_S3_BUCKET ?? "").trim()}）。POST /api/corpus/audio-files/presign → PUT uploadUrl。`
          : "本地 Product API 预签名可用；配置 CORPUS_S3_BUCKET + 密钥可切换云 S3/OSS PutObject 预签名（支持 CORPUS_S3_ENDPOINT + path-style）。",
        requiredEnv: [],
        lastCheckedAt: generatedAt
      },
      {
        id: "voice-endpointing-pvad",
        kind: "voice",
        label: "pVAD 实验端点检测",
        status: "ready",
        active: true,
        detail:
          "endpointingMode=pvad-experimental：浏览器 Silero 神经 VAD（同源 /vad/ onnx+wasm；失败软降级能量/表情启发式）+ cascade turns/stream 子句级流式 TTS。WebRTC 优先建连，失败诚实回退 WebSocket。",
        requiredEnv: [],
        lastCheckedAt: generatedAt
      },
      {
        id: "voice-livekit-interrupt",
        kind: "voice",
        label: "LiveKit barge-in interrupt",
        status: "ready",
        active: true,
        detail:
          "客户端 data channel 发送 {type:interrupt}；Python agent await session.interrupt()，失败时 mute/stop 本地音频轨并打点可观测。本地播报立即静音。",
        requiredEnv: [],
        lastCheckedAt: generatedAt
      },
      {
        id: "bailian-realtime",
        kind: "voice",
        label: "百炼 Qwen-Omni Realtime",
        status: dashscopeKeyConfigured ? "ready" : "needs-key",
        active: dashscopeKeyConfigured,
        detail: buildRealtimeDetail(dashscopeKeyConfigured, realtimeEndpointConfigured, realtimeTransport),
        requiredEnv: ["DASHSCOPE_API_KEY"],
        model: realtimeModels.model,
        // Reuse the resolved transport (defaults to websocket) so the descriptor doesn't
        // claim "ready" on a websocket assumption while displaying "webrtc".
        transport: realtimeTransport,
        lastCheckedAt: generatedAt
      }
    ];

    const metrics = getRuntimeMetricsSnapshot();
    return {
      generatedAt,
      configVersion: state.systemConfig.version,
      // 审计修复(F-02/A2):透出实际生效的产品状态档位(R7:memory|surreal 两档)。
      // E2E globalSetup 靠它断言测试进程没有继承 .env.local 连上真实存储;缺省按 stateStore 如实回落。
      productStore: options.productStore ?? options.stateStore,
      runtime: {
        service: "interview-product-api",
        stateStore: options.stateStore
      },
      metrics: {
        voice: {
          sampleCount: metrics.voice.sampleCount,
          /** Finite TTFA points only — prefer over sampleCount for latency window size. */
          ttfaCount: metrics.voice.ttfaCount,
          ttfaP50Ms: metrics.voice.ttfaP50Ms,
          ttfaP95Ms: metrics.voice.ttfaP95Ms,
          interruptCount: metrics.voice.interruptCount,
          bargeInSuccessCount: metrics.voice.bargeInSuccessCount,
          bargeInFailCount: metrics.voice.bargeInFailCount,
          bargeInSuccessRate: metrics.voice.bargeInSuccessRate,
          interruptRecoveryCount: metrics.voice.interruptRecoveryCount,
          interruptRecoveryRate: metrics.voice.interruptRecoveryRate,
          falseTriggerCount: metrics.voice.falseTriggerCount,
          falseTriggerByKind: metrics.voice.falseTriggerByKind,
          takeFloorCount: metrics.voice.takeFloorCount,
          openingAudibleCount: metrics.voice.openingAudibleCount,
          openingInaudibleCount: metrics.voice.openingInaudibleCount,
          playbackContextState: metrics.voice.playbackContextState,
          ttsTtfbDefinition: metrics.voice.ttsTtfbDefinition,
          segments: metrics.voice.segments,
          budgetHint: metrics.voice.budgetHint
        },
        recall: {
          eventCount: metrics.recall.eventCount,
          hit: metrics.recall.hit,
          empty: metrics.recall.empty,
          low_score: metrics.recall.low_score
        },
        grounding: {
          eventCount: metrics.grounding.eventCount,
          grounded: metrics.grounding.grounded,
          partial: metrics.grounding.partial,
          refused: metrics.grounding.refused,
          groundedAnswerRate: metrics.grounding.groundedAnswerRate,
          refuseRate: metrics.grounding.refuseRate,
          citationPresentRate: metrics.grounding.citationPresentRate
        }
      },
      capabilities
    };
  });
}

function buildRuntimeConfigResponse(options: SystemRouteOptions) {
  const env = options.env ?? process.env;
  const generatedAt = new Date().toISOString();
  return {
    generatedAt,
    envFilePath: options.envFilePath,
    sections: (Object.keys(configSectionLabels) as ConfigSectionId[]).map((sectionId) => ({
      id: sectionId,
      label: configSectionLabels[sectionId],
      settings: runtimeSettingDefinitions
        .filter((definition) => definition.section === sectionId)
        .map((definition) => buildRuntimeSetting(definition, env))
    }))
  };
}

function buildRuntimeSetting(definition: RuntimeSettingDefinition, env: RuntimeEnv) {
  const rawValue = env[definition.key];
  const normalizedValue = typeof rawValue === "string" ? rawValue.trim() : rawValue;
  const configured = normalizedValue !== undefined && normalizedValue !== "";
  const effectiveValue = normalizedValue === "" ? undefined : normalizedValue;
  return {
    key: definition.key,
    section: definition.section,
    label: definition.label,
    description: definition.description,
    valueKind: definition.valueKind,
    secret: Boolean(definition.secret),
    required: Boolean(definition.required),
    configured,
    value: definition.secret ? null : effectiveValue ?? definition.defaultValue ?? "",
    maskedValue: definition.secret ? maskSecretValue(normalizeConfiguredSecret(rawValue)) : undefined,
    defaultValue: definition.defaultValue,
    options: definition.options,
    restartRequired: Boolean(definition.restartRequired)
  };
}

function normalizeRuntimeConfigUpdates(value: unknown): RuntimeEnv {
  const payload = normalizeConfigPayload(value);
  const updates = payload.updates && typeof payload.updates === "object" ? (payload.updates as Record<string, unknown>) : {};
  const allowedDefinitions = new Map(runtimeSettingDefinitions.map((definition) => [definition.key, definition]));

  return Object.entries(updates).reduce<RuntimeEnv>((normalized, [key, rawValue]) => {
    const definition = allowedDefinitions.get(key);
    if (!definition) {
      return normalized;
    }

    const value = normalizeRuntimeConfigValue(rawValue, definition);
    normalized[key] = value === "" && definition.secret ? undefined : value;
    return normalized;
  }, {});
}

function normalizeConfigPayload(value: unknown): RuntimeConfigPayload {
  if (!value || typeof value !== "object") {
    return {};
  }
  return value as RuntimeConfigPayload;
}

function normalizeRuntimeConfigValue(value: unknown, definition: RuntimeSettingDefinition) {
  if (value === null) {
    return "";
  }
  if (definition.valueKind === "boolean") {
    return value === true || value === "true" ? "true" : "false";
  }
  if (definition.valueKind === "number") {
    const parsedValue = Number(value);
    return Number.isFinite(parsedValue) ? String(Math.max(0, Math.floor(parsedValue))) : definition.defaultValue ?? "0";
  }
  return typeof value === "string" ? value.trim() : String(value ?? "").trim();
}

function maskSecretValue(value: string | undefined) {
  // Never reveal any portion of the secret (previously leaked the last 4 chars, readable by
  // anyone when auth is off). The boolean `configured` field on the setting already tells the
  // UI whether a value exists; the display string stays a fixed, value-free mask.
  if (!value) {
    return "未配置";
  }
  return "已配置（••••）";
}

function buildRealtimeDetail(keyConfigured: boolean, _endpointConfigured: boolean, transport: string) {
  if (!keyConfigured) {
    return "缺少 DASHSCOPE_API_KEY 或 BAILIAN_API_KEY，实时语音不会连接百炼。";
  }
  if (transport === "websocket") {
    return "服务端已配置 WebSocket 代理；浏览器经 Product API 建立实时语音会话。cascade 路径默认优先。";
  }
  return "WebRTC 使用公网 DashScope signaling（可 BAILIAN_REALTIME_WEBRTC_ENDPOINT 覆盖，无需白名单）；SDP 经 POST .../webrtc/answer 代理，失败诚实回退 WebSocket。";
}
