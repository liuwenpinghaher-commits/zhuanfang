import type { FastifyInstance } from "fastify";
import {
  BAILIAN_PODCAST_TTS_MODEL,
  BAILIAN_PODCAST_TTS_VOICE,
  BAILIAN_REALTIME_MODEL,
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
import type { ProductStateRepository } from "../product-state-repository";

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
  lastCheckedAt: string;
}

interface SystemRouteOptions {
  stateStore: "memory" | "sqlite";
  env?: RuntimeEnv;
  envFilePath?: string;
  refreshProviderClients?: () => void;
  bailianSearchClient?: BailianSearchClient;
  anySearchClient?: AnySearchClient;
  bailianPodcastAudioClient?: BailianPodcastAudioClient;
  bailianInterviewClient?: BailianCharacterInterviewClient;
  bailianRealtimeVoiceClient?: BailianRealtimeVoiceClient;
  bailianTranscriptionClient?: BailianAudioTranscriptionClient;
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
    key: "BAILIAN_BASE_URL",
    section: "models",
    label: "百炼兼容模式 Base URL",
    description: "联网搜索和角色扮演 Chat/Responses API 的服务端地址。",
    valueKind: "string",
    defaultValue: "https://dashscope.aliyuncs.com/compatible-mode/v1"
  },
  {
    key: "BAILIAN_AUDIO_BASE_URL",
    section: "models",
    label: "百炼音频 Base URL",
    description: "CosyVoice TTS 与 SenseVoice ASR 的服务端地址。",
    valueKind: "string",
    defaultValue: "https://dashscope.aliyuncs.com"
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
    description: "CosyVoice 语音合成使用的音色。",
    valueKind: "select",
    defaultValue: BAILIAN_PODCAST_TTS_VOICE,
    options: COSYVOICE_PRESET_VOICES.map((v) => ({ label: `${v.name} (${v.voice})`, value: v.voice }))
  },
  {
    key: "BAILIAN_ASR_LANGUAGE_HINT",
    section: "voice",
    label: "音频转写语言提示",
    description: "SenseVoice language_hints，通常使用 zh 或 auto。",
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
    description: "百炼 Qwen-Omni Realtime SDP 代理 endpoint。",
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
    description: "Qwen-Omni Realtime 使用的音色。可通过声音复刻创建自定义音色。",
    valueKind: "select",
    defaultValue: "Ethan",
    options: [
      { label: "晨煦 Ethan", value: "Ethan" },
      { label: "甜甜 Tina", value: "Tina" },
      { label: "苏瑶 Serena", value: "Serena" },
      { label: "厚 Harvey", value: "Harvey" },
      { label: "四月 Maia", value: "Maia" },
      { label: "江晨 Evan", value: "Evan" },
      { label: "舒然 Mia", value: "Mia" },
      { label: "清欢 Liora Mira", value: "Liora Mira" },
      { label: "知芝 Sunnybobi", value: "Sunnybobi" },
      { label: "林欣宜 Cindy", value: "Cindy" },
      { label: "林川野 Raymond", value: "Raymond" },
      { label: "予安 Theo Calm", value: "Theo Calm" },
      { label: "小乔妹 Qiao", value: "Qiao" },
      { label: "茉兔 Momo", value: "Momo" },
      { label: "伟伦 Wil", value: "Wil" },
      { label: "安琪 Angel", value: "Angel" },
      { label: "卡捷琳娜 Katerina", value: "Katerina" },
      { label: "甜茶 Ryan", value: "Ryan" },
      { label: "詹妮弗 Jennifer", value: "Jennifer" },
      { label: "艾登 Aiden", value: "Aiden" },
      { label: "敏儿 Mione", value: "Mione" },
      { label: "素熙 Sohee", value: "Sohee" },
      { label: "莱恩 Lenn", value: "Lenn" },
      { label: "小野杏 Ono Anna", value: "Ono Anna" },
      { label: "索尼莎 Sonrisa", value: "Sonrisa" },
      { label: "博德加 Bodega", value: "Bodega" },
      { label: "埃米尔安 Emilien", value: "Emilien" },
      { label: "安德雷 Andre", value: "Andre" },
      { label: "阿列克 Alek", value: "Alek" },
      { label: "阿力 Rizky", value: "Rizky" },
      { label: "萝雅 Roya", value: "Roya" },
      { label: "阿尔达 Arda", value: "Arda" },
      { label: "阿幸 Hana", value: "Hana" },
      { label: "多尔切 Dolce", value: "Dolce" },
      { label: "雅克 Jakub", value: "Jakub" },
      { label: "海娜 Griet", value: "Griet" },
      { label: "艾莉卡 Eliška", value: "Eliška" },
      { label: "玛丽娜 Marina", value: "Marina" },
      { label: "西芮 Siiri", value: "Siiri" },
      { label: "林恩 Ingrid", value: "Ingrid" },
      { label: "海娜 Sigga", value: "Sigga" },
      { label: "雅娜 Bea", value: "Bea" },
      { label: "思怡 Chloe", value: "Chloe" },
      { label: "李公公 Li Cassian", value: "Li Cassian" },
      { label: "阿逗 Joyner", value: "Joyner" },
      { label: "金爷 Gold", value: "Gold" },
      { label: "四川-晴儿 Sunny", value: "Sunny" },
      { label: "北京-晓东 Dylan", value: "Dylan" },
      { label: "四川-程川 Eric", value: "Eric" },
      { label: "天津-李彼得 Peter", value: "Peter" },
      { label: "阿樸伯 Joseph Chen", value: "Joseph Chen" },
      { label: "陕西-秦川 Marcus", value: "Marcus" },
      { label: "南京-老李 Li", value: "Li" },
      { label: "粤语-阿清 Kiki", value: "Kiki" },
      { label: "粤语-阿强 Rocky", value: "Rocky" },
      { label: "拉迪奥·戈尔 Radio Gol", value: "Radio Gol" },
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
    description: "SQLite 状态库路径；切换后需要重启 API 才会更换存储后端。",
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
    const dashscopeKeyConfigured = Boolean(env.DASHSCOPE_API_KEY ?? env.BAILIAN_API_KEY);
    const anySearchKeyConfigured = Boolean(env.ANYSEARCH_API_KEY);
    const anySearchAnonymous = env.ANYSEARCH_ALLOW_ANONYMOUS === "true";
    const realtimeEndpointConfigured = Boolean(env.BAILIAN_REALTIME_WEBRTC_ENDPOINT);
    const realtimeTransport = env.BAILIAN_REALTIME_TRANSPORT === "webrtc" ? "webrtc" : "websocket";

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
        // Memory mode works but is NOT persistent — surface it as degraded (not the same
        // green "ready" as durable SQLite), and drop the PRODUCT_STATE_DB_PATH requirement
        // that memory mode doesn't actually need.
        label: "Product State Store",
        status: options.stateStore === "sqlite" ? "ready" : "degraded",
        active: true,
        detail: options.stateStore === "sqlite"
          ? "SQLite 状态库已启用，数据持久化。"
          : "内存状态库已启用：数据不持久，重启后回到 seed 状态；导出仅为当前会话快照。",
        requiredEnv: options.stateStore === "sqlite" ? ["PRODUCT_STATE_DB_PATH"] : [],
        lastCheckedAt: generatedAt
      },
      {
        id: "bailian-responses",
        kind: "search",
        label: "百炼 Responses 内置联网",
        status: options.bailianSearchClient ? "ready" : "needs-key",
        active: state.systemConfig.search.activeProvider === "bailian",
        detail: options.bailianSearchClient
          ? "已通过服务端 key 配置，可调用 qwen3.7-plus Responses web_search / web_extractor。"
          : "缺少 DASHSCOPE_API_KEY 或 BAILIAN_API_KEY，百炼联网搜索会降级。",
        requiredEnv: ["DASHSCOPE_API_KEY"],
        model: env.BAILIAN_SEARCH_MODEL ?? BAILIAN_LATEST_PLUS_MODEL,
        lastCheckedAt: generatedAt
      },
      {
        id: "anysearch",
        kind: "search",
        label: "AnySearch",
        status: options.anySearchClient ? "ready" : "needs-key",
        active: state.systemConfig.search.activeProvider === "anysearch",
        detail: options.anySearchClient
          ? anySearchKeyConfigured
            ? "已配置 ANYSEARCH_API_KEY，可通过 Product API 调用 AnySearch /v1/search。"
            : "已显式启用 AnySearch 匿名模式，额度和并发受匿名策略限制。"
          : "ANYSEARCH_API_KEY 未配置，AnySearch 将降级为本地可复核素材。",
        requiredEnv: anySearchAnonymous ? ["ANYSEARCH_ALLOW_ANONYMOUS"] : ["ANYSEARCH_API_KEY"],
        lastCheckedAt: generatedAt
      },
      {
        id: "bailian-cosyvoice",
        kind: "voice",
        label: "百炼 CosyVoice 播客 TTS",
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
        label: "百炼 SenseVoice 录音转写",
        status: options.bailianTranscriptionClient ? "ready" : "needs-key",
        active: true,
        detail: options.bailianTranscriptionClient
          ? "已配置服务端 ASR provider，可把公网音频 URL 转写为语料分析稿。"
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
        active: state.systemConfig.models.interviewModel === "qwen-plus-character",
        detail: options.bailianInterviewClient
          ? "已配置 qwen-plus-character，文本专访追问可走百炼角色扮演。"
          : "缺少 DASHSCOPE_API_KEY 或 BAILIAN_API_KEY，文本专访会使用本地规则引擎。",
        requiredEnv: ["DASHSCOPE_API_KEY"],
        model: env.BAILIAN_CHARACTER_MODEL ?? BAILIAN_ROLE_PLAY_MODEL,
        lastCheckedAt: generatedAt
      },
      {
        id: "bailian-realtime",
        kind: "voice",
        label: "百炼 Qwen-Omni Realtime",
        status: dashscopeKeyConfigured
          ? (realtimeTransport === "websocket" || realtimeEndpointConfigured)
            ? "ready"
            : "needs-endpoint"
          : "needs-key",
        active: dashscopeKeyConfigured && (realtimeTransport === "websocket" || realtimeEndpointConfigured),
        detail: buildRealtimeDetail(dashscopeKeyConfigured, realtimeEndpointConfigured, realtimeTransport),
        requiredEnv: realtimeTransport === "websocket"
          ? ["DASHSCOPE_API_KEY"]
          : ["DASHSCOPE_API_KEY", "BAILIAN_REALTIME_WEBRTC_ENDPOINT"],
        model: env.BAILIAN_REALTIME_MODEL ?? BAILIAN_REALTIME_MODEL,
        // Reuse the resolved transport (defaults to websocket) so the descriptor doesn't
        // claim "ready" on a websocket assumption while displaying "webrtc".
        transport: realtimeTransport,
        lastCheckedAt: generatedAt
      }
    ];

    return {
      generatedAt,
      configVersion: state.systemConfig.version,
      runtime: {
        service: "interview-product-api",
        stateStore: options.stateStore
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
  const configured = rawValue !== undefined && rawValue !== "";
  return {
    key: definition.key,
    section: definition.section,
    label: definition.label,
    description: definition.description,
    valueKind: definition.valueKind,
    secret: Boolean(definition.secret),
    required: Boolean(definition.required),
    configured,
    value: definition.secret ? null : rawValue ?? definition.defaultValue ?? "",
    maskedValue: definition.secret ? maskSecretValue(rawValue) : undefined,
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

function buildRealtimeDetail(keyConfigured: boolean, endpointConfigured: boolean, transport: string) {
  if (!keyConfigured) {
    return "缺少 DASHSCOPE_API_KEY 或 BAILIAN_API_KEY，实时语音不会连接百炼。";
  }
  if (transport === "websocket") {
    return "服务端已配置 WebSocket 代理，浏览器可通过 Product API 建立实时语音会话。";
  }
  if (!endpointConfigured) {
    return "缺少 BAILIAN_REALTIME_WEBRTC_ENDPOINT，WebRTC 需要白名单 Endpoint。可设置 BAILIAN_REALTIME_TRANSPORT=websocket 使用 WebSocket 通道。";
  }
  return "服务端已配置 WebRTC SDP 代理，浏览器可通过 Product API 建立实时语音会话。";
}
