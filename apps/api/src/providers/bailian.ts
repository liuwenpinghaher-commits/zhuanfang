import type { InteractionPreSignals, InterviewSession, SearchBriefInput, SearchProviderId, SourceHighlight } from "../../../../src/domain/types";

export const BAILIAN_DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
export const BAILIAN_DEFAULT_AUDIO_BASE_URL = "https://dashscope.aliyuncs.com";
export const BAILIAN_LATEST_PLUS_MODEL = "qwen3.7-plus";
export const BAILIAN_ROLE_PLAY_MODEL = "qwen-plus-character";
export const BAILIAN_PODCAST_TTS_MODEL = "cosyvoice-v3-plus";
export const BAILIAN_PODCAST_TTS_VOICE = "longyuan_v3";
export const BAILIAN_REALTIME_MODEL = "qwen3.5-omni-plus-realtime";
export const BAILIAN_TRANSCRIPTION_MODEL = "sensevoice-v1";
// General-purpose text model for server-side synthesis (diary, review, corpus, intel).
// qwen-plus is fast (~0.8s) and supports JSON mode — verified live. Kept separate from
// BAILIAN_SEARCH_MODEL (qwen3.7-plus, ~9s) so synthesis never inherits the slow search model.
export const BAILIAN_GENERAL_MODEL = "qwen-plus";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface BailianSearchClient {
  createSearchBrief(input: BailianSearchBriefRequest): Promise<SearchBriefInput>;
}

export interface BailianCharacterInterviewClient {
  createAssistantTurn(input: BailianCharacterInterviewRequest): Promise<BailianCharacterInterviewResult>;
}

export interface BailianRealtimeVoiceClient {
  createWebrtcAnswer(input: BailianRealtimeWebrtcRequest): Promise<string>;
}

export interface BailianAudioTranscriptionClient {
  transcribe(input: BailianAudioTranscriptionRequest): Promise<BailianAudioTranscriptionResult>;
}

export interface BailianChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface BailianChatCompleteRequest {
  messages: BailianChatMessage[];
  model?: string;
  responseFormat?: "json" | "text";
  temperature?: number;
  maxTokens?: number;
}

/**
 * Reusable "messages -> text" LLM client. The foundation for all server-side
 * synthesis (diary finalize, review, corpus, intel). Throws on transport/HTTP
 * failure so callers can fall back to deterministic domain functions.
 */
export interface BailianChatClient {
  complete(input: BailianChatCompleteRequest): Promise<string>;
}

export interface BailianSearchBriefRequest {
  topic: string;
  providerId: Extract<SearchProviderId, "bailian">;
  maxSources: number;
  recencyDays: number;
}

export interface BailianCharacterInterviewRequest {
  session: InterviewSession;
  userText: string;
}

export interface BailianCharacterInterviewResult {
  providerId: "bailian-character";
  model: string;
  content: string;
  intent: "百炼角色扮演追问";
  preSignals?: InteractionPreSignals;
}

export interface BailianRealtimeWebrtcRequest {
  model: string;
  offerSdp: string;
}

export interface BailianPodcastAudioClient {
  synthesize(input: BailianPodcastAudioRequest): Promise<BailianPodcastAudioResult>;
}

export interface BailianPodcastAudioRequest {
  text: string;
  voice?: string;
  format?: "mp3" | "wav" | "pcm";
}

export interface BailianPodcastAudioResult {
  providerId: "bailian-cosyvoice";
  model: string;
  voice: string;
  audioUrl: string;
  expiresAt?: number;
  durationSec?: number;
}

export interface BailianAudioTranscriptionRequest {
  title?: string;
  sourceUrl: string;
  languageHint?: string;
  disfluencyRemovalEnabled?: boolean;
}

export interface BailianAudioTranscriptionResult {
  providerId: "bailian-sensevoice";
  model: string;
  sourceUrl: string;
  taskId: string;
  text: string;
  transcriptionUrl?: string;
  durationSec?: number;
}

interface BailianSearchClientOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  fetchImpl?: FetchLike;
}

interface BailianCharacterInterviewClientOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  fetchImpl?: FetchLike;
}

interface BailianChatClientOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  fetchImpl?: FetchLike;
}

interface BailianRealtimeVoiceClientOptions {
  apiKey: string;
  webrtcEndpoint: string;
  fetchImpl?: FetchLike;
}

interface BailianPodcastAudioClientOptions {
  apiKey: string;
  audioBaseUrl?: string;
  model?: string;
  voice?: string;
  fetchImpl?: FetchLike;
}

interface BailianAudioTranscriptionClientOptions {
  apiKey: string;
  audioBaseUrl?: string;
  model?: string;
  languageHint?: string;
  pollAttempts?: number;
  pollIntervalMs?: number;
  fetchImpl?: FetchLike;
}

interface BailianResponsesOutput {
  output_text?: string;
  output?: Array<{
    content?: Array<{
      text?: string;
    }>;
  }>;
}

interface BailianSearchJson {
  summary?: unknown;
  facts?: unknown;
  controversies?: unknown;
  opposingViews?: unknown;
  opposing_views?: unknown;
  interviewAngles?: unknown;
  interview_angles?: unknown;
  discussionTopics?: unknown;
  sourceAngles?: unknown;
  sources?: unknown;
}

interface BailianPodcastAudioOutput {
  output?: {
    audio?: {
      url?: unknown;
      expires_at?: unknown;
      duration?: unknown;
    };
  };
}

interface BailianTranscriptionSubmitOutput {
  output?: {
    task_status?: unknown;
    task_id?: unknown;
  };
}

interface BailianTranscriptionTaskOutput {
  output?: {
    task_id?: unknown;
    task_status?: unknown;
    results?: unknown;
    usage?: {
      duration?: unknown;
    };
  };
  usage?: {
    duration?: unknown;
  };
}

interface BailianTranscriptionResultItem {
  file_url?: unknown;
  transcription_url?: unknown;
  subtask_status?: unknown;
}

interface BailianTranscriptionJson {
  transcripts?: Array<{
    text?: unknown;
    sentences?: Array<{
      text?: unknown;
    }>;
  }>;
}

interface BailianChatCompletionOutput {
  choices?: Array<{
    message?: {
      content?: unknown;
    };
  }>;
}

export function createBailianSearchClient(options: BailianSearchClientOptions): BailianSearchClient {
  const baseUrl = (options.baseUrl ?? BAILIAN_DEFAULT_BASE_URL).replace(/\/$/, "");
  const model = options.model ?? BAILIAN_LATEST_PLUS_MODEL;
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    async createSearchBrief(input) {
      const response = await fetchImpl(`${baseUrl}/responses`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model,
          input: buildSearchPrompt(input),
          tools: [{ type: "web_search" }, { type: "web_extractor" }, { type: "code_interpreter" }]
        })
      });

      if (!response.ok) {
        throw new Error(`Bailian Responses API request failed: ${response.status}`);
      }

      const payload = (await response.json()) as BailianResponsesOutput;
      const parsedOutput = parseSearchJson(extractOutputText(payload));

      return {
        topic: input.topic,
        provider: "bailian",
        status: "ready",
        summary:
          typeof parsedOutput.summary === "string" && parsedOutput.summary.trim()
            ? parsedOutput.summary.trim()
            : `${input.topic} 的百炼联网搜索结果已生成，需要在专访中结合个人上下文使用。`,
        facts: normalizeStringList(parsedOutput.facts, [
          `${input.topic} 的百炼联网结果需要回到用户自己的具体业务场景中验证。`
        ]),
        controversies: normalizeStringList(parsedOutput.controversies, [
          "争议：外部热点能提供线索，但不能替代用户自己的判断证据。"
        ]),
        opposingViews: normalizeStringList(parsedOutput.opposingViews ?? parsedOutput.opposing_views, [
          "反方观点：如果缺少可复盘行动，热点素材可能只是认知噪音。"
        ]),
        interviewAngles: normalizeStringList(parsedOutput.interviewAngles ?? parsedOutput.interview_angles, [
          `专访角度：${input.topic} 和用户最近的真实选择有什么关系？`
        ]),
        discussionTopics: normalizeStringList(parsedOutput.discussionTopics, [
          `专访切入：${input.topic} 对你当前判断的真实影响是什么？`,
          "哪些外部信息值得作为访谈追问材料，哪些只是噪音？"
        ]),
        sourceAngles: normalizeStringList(parsedOutput.sourceAngles, [
          "优先把联网信息作为追问线索，而不是直接写成用户结论。"
        ]),
        sources: normalizeSources(parsedOutput.sources, input)
      };
    }
  };
}

async function safeReadErrorBody(response: Response): Promise<string> {
  try {
    return (await response.text()).replace(/\s+/g, " ").slice(0, 300);
  } catch {
    return "";
  }
}

export function createBailianChatClient(options: BailianChatClientOptions): BailianChatClient {
  const baseUrl = (options.baseUrl ?? BAILIAN_DEFAULT_BASE_URL).replace(/\/$/, "");
  const defaultModel = options.model ?? BAILIAN_GENERAL_MODEL;
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    async complete(input) {
      const model = input.model ?? defaultModel;
      const body: Record<string, unknown> = {
        model,
        messages: input.messages
      };
      if (typeof input.temperature === "number") {
        body.temperature = input.temperature;
      }
      if (typeof input.maxTokens === "number") {
        body.max_tokens = input.maxTokens;
      }
      if (input.responseFormat === "json") {
        body.response_format = { type: "json_object" };
      }

      const response = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          "content-type": "application/json"
        },
        body: JSON.stringify(body)
      });

      if (!response.ok) {
        throw new Error(`Bailian chat completion failed (${model}): ${response.status} ${await safeReadErrorBody(response)}`);
      }

      const payload = (await response.json()) as BailianChatCompletionOutput;
      const content = payload.choices?.[0]?.message?.content;
      if (typeof content !== "string" || !content.trim()) {
        throw new Error(`Bailian chat completion returned empty content (${model}).`);
      }
      return content;
    }
  };
}

export function createBailianCharacterInterviewClient(
  options: BailianCharacterInterviewClientOptions
): BailianCharacterInterviewClient {
  const model = options.model ?? BAILIAN_ROLE_PLAY_MODEL;
  const chatClient = createBailianChatClient({
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
    model,
    fetchImpl: options.fetchImpl
  });

  return {
    async createAssistantTurn(input) {
      const rawContent = await chatClient.complete({
        messages: buildCharacterMessages(input.session, input.userText)
      });

      const { content, preSignals } = extractPreSignals(rawContent.trim());

      return {
        providerId: "bailian-character",
        model,
        content,
        intent: "百炼角色扮演追问",
        ...(preSignals ? { preSignals } : {}),
      };
    }
  };
}

function extractPreSignals(text: string): { content: string; preSignals?: InteractionPreSignals } {
  const match = text.match(/<pre_signals>([\s\S]*?)<\/pre_signals>/);
  if (!match) {
    return { content: text };
  }

  const block = match[1];
  const cleanContent = text.replace(match[0], "").trim();

  // Parse each line into key-value pairs.  Use raw lines so we can
  // detect indentation (sub-fields of depth_direction).
  const rawLines = block.split("\n");
  const entries: Record<string, string> = {};
  let currentKey = "";

  for (const rawLine of rawLines) {
    const line = rawLine.trim();
    if (!line) continue;

    const kvMatch = line.match(/^([a-z_]+):\s*(.*)/);
    if (!kvMatch) continue;

    const key = kvMatch[1];
    const value = kvMatch[2].trim();

    // If the raw line starts with whitespace and we have a currentKey,
    // this is a sub-field continuation (e.g. "  concept: X" under
    // "depth_direction:").
    if (rawLine.startsWith(" ") || rawLine.startsWith("\t")) {
      if (currentKey) {
        entries[`${currentKey}.${key}`] = value;
      }
    } else {
      currentKey = key;
      entries[key] = value;
    }
  }

  // Parse depth_direction sub-fields
  const concept = entries["depth_direction.concept"];
  const reason = entries["depth_direction.reason"] || "";
  const guidance = entries["depth_direction.guidance"] || "";

  const result: InteractionPreSignals = {
    depthDirection: concept ? { concept, reason, guidance } : null,
    backchannelWhitelist: parseListEntry(entries["backchannel"], ["嗯", "对", "是的", "好"]),
    interruptTriggers: parseListEntry(entries["interrupt"], ["不对", "不是", "等一下"]),
    interruptSensitivity: (["low", "medium", "high"].includes(entries["sensitivity"] ?? "")
      ? (entries["sensitivity"] as "low" | "medium" | "high")
      : "medium"),
  };

  return { content: cleanContent, preSignals: result };
}

function parseListEntry(raw: string | undefined, fallback: string[]): string[] {
  if (!raw) return fallback;
  // Strip surrounding brackets, quotes, and whitespace
  const cleaned = raw.replace(/^\[|\]$/g, "").replace(/"/g, "").replace(/'/g, "");
  const items = cleaned.split(",").map((s) => s.trim()).filter(Boolean);
  return items.length > 0 ? items : fallback;
}

export function createBailianRealtimeVoiceClient(options: BailianRealtimeVoiceClientOptions): BailianRealtimeVoiceClient {
  const signalingUrl = normalizeWebrtcSignalingUrl(options.webrtcEndpoint);
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    async createWebrtcAnswer(input) {
      const response = await fetchImpl(`${signalingUrl}?model=${encodeURIComponent(input.model)}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          "content-type": "application/sdp"
        },
        body: input.offerSdp
      });

      if (!response.ok) {
        throw new Error(`Bailian Realtime WebRTC SDP exchange failed: ${response.status}`);
      }

      return response.text();
    }
  };
}

export function createBailianPodcastAudioClient(options: BailianPodcastAudioClientOptions): BailianPodcastAudioClient {
  const audioBaseUrl = (options.audioBaseUrl ?? BAILIAN_DEFAULT_AUDIO_BASE_URL).replace(/\/$/, "");
  const model = options.model ?? BAILIAN_PODCAST_TTS_MODEL;
  const defaultVoice = options.voice ?? BAILIAN_PODCAST_TTS_VOICE;
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    async synthesize(input) {
      const voice = input.voice?.trim() || defaultVoice;
      const format = input.format ?? "mp3";
      const response = await fetchImpl(`${audioBaseUrl}/api/v1/services/audio/tts/SpeechSynthesizer`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model,
          input: {
            text: input.text,
            voice,
            format,
            sample_rate: 24000,
            rate: 0.95,
            enable_markdown_filter: true,
            enable_aigc_tag: true
          }
        })
      });

      if (!response.ok) {
        throw new Error(`Bailian CosyVoice request failed: ${response.status}`);
      }

      const payload = (await response.json()) as BailianPodcastAudioOutput;
      const audioUrl = payload.output?.audio?.url;
      if (typeof audioUrl !== "string" || !audioUrl.trim()) {
        throw new Error("Bailian CosyVoice response did not include an audio URL.");
      }

      return {
        providerId: "bailian-cosyvoice",
        model,
        voice,
        audioUrl: audioUrl.trim(),
        expiresAt: normalizeOptionalNumber(payload.output?.audio?.expires_at),
        durationSec: normalizeOptionalNumber(payload.output?.audio?.duration)
      };
    }
  };
}

export function createBailianAudioTranscriptionClient(
  options: BailianAudioTranscriptionClientOptions
): BailianAudioTranscriptionClient {
  const audioBaseUrl = (options.audioBaseUrl ?? BAILIAN_DEFAULT_AUDIO_BASE_URL).replace(/\/$/, "");
  const model = options.model ?? BAILIAN_TRANSCRIPTION_MODEL;
  const languageHint = options.languageHint ?? "auto";
  const pollAttempts = options.pollAttempts ?? 20;
  const pollIntervalMs = options.pollIntervalMs ?? 500;
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    async transcribe(input) {
      const sourceUrl = input.sourceUrl.trim();
      const submitResponse = await fetchImpl(`${audioBaseUrl}/api/v1/services/audio/asr/transcription`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          "content-type": "application/json",
          "X-DashScope-Async": "enable"
        },
        body: JSON.stringify({
          model,
          input: {
            file_urls: [sourceUrl]
          },
          parameters: {
            channel_id: [0],
            disfluency_removal_enabled: input.disfluencyRemovalEnabled ?? true,
            language_hints: [input.languageHint ?? languageHint]
          }
        })
      });

      if (!submitResponse.ok) {
        throw new Error(`Bailian SenseVoice transcription submit failed: ${submitResponse.status}`);
      }

      const submitPayload = (await submitResponse.json()) as BailianTranscriptionSubmitOutput;
      const taskId = submitPayload.output?.task_id;
      if (typeof taskId !== "string" || !taskId.trim()) {
        throw new Error("Bailian SenseVoice transcription response did not include a task id.");
      }

      for (let attempt = 0; attempt < pollAttempts; attempt += 1) {
        if (attempt > 0 && pollIntervalMs > 0) {
          await delay(pollIntervalMs);
        }

        const taskResponse = await fetchImpl(`${audioBaseUrl}/api/v1/tasks/${encodeURIComponent(taskId)}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${options.apiKey}`,
            "content-type": "application/json"
          }
        });

        if (!taskResponse.ok) {
          throw new Error(`Bailian SenseVoice transcription task query failed: ${taskResponse.status}`);
        }

        const taskPayload = (await taskResponse.json()) as BailianTranscriptionTaskOutput;
        const taskStatus = taskPayload.output?.task_status;
        if (taskStatus === "FAILED" || taskStatus === "CANCELED") {
          throw new Error(`Bailian SenseVoice transcription task ended with ${taskStatus}.`);
        }
        if (taskStatus !== "SUCCEEDED") {
          continue;
        }

        const result = pickSuccessfulTranscriptionResult(taskPayload.output?.results, sourceUrl);
        const transcriptionUrl = result?.transcription_url;
        if (typeof transcriptionUrl !== "string" || !transcriptionUrl.trim()) {
          throw new Error("Bailian SenseVoice transcription task did not include a transcription URL.");
        }

        const transcriptionResponse = await fetchImpl(transcriptionUrl.trim(), { method: "GET" });
        if (!transcriptionResponse.ok) {
          throw new Error(`Bailian SenseVoice transcription result fetch failed: ${transcriptionResponse.status}`);
        }

        const transcriptionPayload = (await transcriptionResponse.json()) as BailianTranscriptionJson;
        const text = extractTranscriptionText(transcriptionPayload);
        if (!text) {
          throw new Error("Bailian SenseVoice transcription result did not include text.");
        }

        return {
          providerId: "bailian-sensevoice",
          model,
          sourceUrl,
          taskId,
          transcriptionUrl: transcriptionUrl.trim(),
          durationSec: normalizeOptionalNumber(taskPayload.output?.usage?.duration ?? taskPayload.usage?.duration),
          text
        };
      }

      throw new Error("Bailian SenseVoice transcription task did not finish before timeout.");
    }
  };
}

export function createBailianSearchClientFromEnv(env: Record<string, string | undefined> = process.env): BailianSearchClient | undefined {
  const apiKey = env.DASHSCOPE_API_KEY ?? env.BAILIAN_API_KEY;
  if (!apiKey) {
    return undefined;
  }

  return createBailianSearchClient({
    apiKey,
    baseUrl: env.BAILIAN_BASE_URL,
    model: env.BAILIAN_SEARCH_MODEL ?? env.BAILIAN_MODEL ?? BAILIAN_LATEST_PLUS_MODEL
  });
}

export function createBailianCharacterInterviewClientFromEnv(
  env: Record<string, string | undefined> = process.env
): BailianCharacterInterviewClient | undefined {
  const apiKey = env.DASHSCOPE_API_KEY ?? env.BAILIAN_API_KEY;
  if (!apiKey) {
    return undefined;
  }

  return createBailianCharacterInterviewClient({
    apiKey,
    baseUrl: env.BAILIAN_BASE_URL,
    model: env.BAILIAN_CHARACTER_MODEL ?? BAILIAN_ROLE_PLAY_MODEL
  });
}

export function createBailianChatClientFromEnv(
  env: Record<string, string | undefined> = process.env
): BailianChatClient | undefined {
  const apiKey = env.DASHSCOPE_API_KEY ?? env.BAILIAN_API_KEY;
  if (!apiKey) {
    return undefined;
  }

  return createBailianChatClient({
    apiKey,
    baseUrl: env.BAILIAN_BASE_URL,
    model: env.BAILIAN_GENERAL_MODEL ?? BAILIAN_GENERAL_MODEL
  });
}

export function createBailianRealtimeVoiceClientFromEnv(
  env: Record<string, string | undefined> = process.env
): BailianRealtimeVoiceClient | undefined {
  const apiKey = env.DASHSCOPE_API_KEY ?? env.BAILIAN_API_KEY;
  const webrtcEndpoint = env.BAILIAN_REALTIME_WEBRTC_ENDPOINT;
  if (!apiKey || !webrtcEndpoint) {
    return undefined;
  }

  return createBailianRealtimeVoiceClient({
    apiKey,
    webrtcEndpoint
  });
}

export function createBailianPodcastAudioClientFromEnv(
  env: Record<string, string | undefined> = process.env
): BailianPodcastAudioClient | undefined {
  const apiKey = env.DASHSCOPE_API_KEY ?? env.BAILIAN_API_KEY;
  if (!apiKey) {
    return undefined;
  }

  return createBailianPodcastAudioClient({
    apiKey,
    audioBaseUrl: env.BAILIAN_AUDIO_BASE_URL,
    model: env.BAILIAN_TTS_MODEL ?? BAILIAN_PODCAST_TTS_MODEL,
    voice: env.BAILIAN_TTS_VOICE ?? BAILIAN_PODCAST_TTS_VOICE
  });
}

export function createBailianAudioTranscriptionClientFromEnv(
  env: Record<string, string | undefined> = process.env
): BailianAudioTranscriptionClient | undefined {
  const apiKey = env.DASHSCOPE_API_KEY ?? env.BAILIAN_API_KEY;
  if (!apiKey) {
    return undefined;
  }

  return createBailianAudioTranscriptionClient({
    apiKey,
    audioBaseUrl: env.BAILIAN_AUDIO_BASE_URL,
    model: env.BAILIAN_ASR_MODEL ?? BAILIAN_TRANSCRIPTION_MODEL,
    languageHint: env.BAILIAN_ASR_LANGUAGE_HINT,
    pollAttempts: normalizeEnvInteger(env.BAILIAN_ASR_POLL_ATTEMPTS, 20),
    pollIntervalMs: normalizeEnvInteger(env.BAILIAN_ASR_POLL_INTERVAL_MS, 500)
  });
}

function buildSearchPrompt(input: BailianSearchBriefRequest) {
  return [
    "你是私人专访产品的联网素材研究员。",
    `请围绕主题「${input.topic}」使用百炼内置联网搜索与网页抓取能力，输出可直接带入专访的问题素材。`,
    `搜索窗口：近 ${input.recencyDays} 天。最多保留 ${input.maxSources} 个高质量来源。`,
    "输出必须是 JSON，不要输出 Markdown。",
    JSON.stringify({
      summary: "一句整合摘要",
      facts: ["可被来源支持的事实 1", "可被来源支持的事实 2"],
      controversies: ["围绕主题的争议点 1"],
      opposingViews: ["反方观点或谨慎解释 1"],
      interviewAngles: ["可以带入专访的追问角度 1"],
      discussionTopics: ["适合专访的问题 1", "适合专访的问题 2", "适合专访的问题 3"],
      sourceAngles: ["来源如何影响访谈追问的角度"],
      sources: [
        {
          title: "来源标题",
          url: "https://example.com",
          publisher: "发布方",
          publishedAt: "ISO 时间或空字符串",
          snippet: "来源摘要",
          relevanceScore: 0.9,
          usage: "topic-suggestion"
        }
      ]
    })
  ].join("\n");
}

function buildCharacterMessages(session: InterviewSession, userText: string): BailianChatMessage[] {
  return [
    {
      role: "system",
      content: buildCharacterSystemPrompt(session)
    },
    {
      role: "assistant",
      content: session.card.suggestedOpening
    },
    ...session.turns.slice(-8).map((turn) => ({
      role: turn.role,
      content: turn.content
    })),
    {
      role: "user",
      content: userText
    }
  ];
}

function buildCharacterSystemPrompt(session: InterviewSession) {
  const guide = session.guide;
  const lines: string[] = [
    "你是一个真正的专访主持人，不是普通聊天助手。",
    "你的目标是通过自然、克制、有人味的追问，帮助被访者把模糊表达推进到具体事件、真实张力、可验证问题和可沉淀资产。",
    `本轮模式：${session.mode}。追问强度：${session.strength}。`,
    `本次主题：${session.title}。`,
    `为什么现在聊：${session.card.whyNow}`,
    `潜在张力：${session.card.potentialTension}`,
    `建议视角：${session.card.suggestedPerspectives.join("、")}`,
  ];

  // 注入长期上下文：让追问能引用历史、指出前后矛盾、回访知识债、戳盲区。
  // 全部「仅当自然相关时使用」，避免硬塞。
  if (guide) {
    if (guide.relevantMemories?.length) {
      lines.push(`【可引用的历史】（如自然相关，可引用其中一条来追问或指出前后变化，不要生硬套用）：${guide.relevantMemories.slice(0, 4).join("；")}`);
    }
    if (guide.statedPositions?.length) {
      lines.push(`【用户过去的立场】（若本次出现矛盾，温和地把矛盾指出来追问）：${guide.statedPositions.slice(0, 3).join("；")}`);
    }
    if (guide.opinionEvolution?.length) {
      const evo = guide.opinionEvolution.slice(0, 2).map((item) => `「${item.topic}」从「${item.oldView}」变到「${item.newView}」`).join("；");
      lines.push(`【观点演变】（可顺势确认变化是否成立）：${evo}`);
    }
    const debts = (guide.openDebts ?? []).slice(0, 3).map((debt) => debt.concept);
    if (debts.length) {
      lines.push(`【未还知识债】（合适时回访其中一个）：${debts.join("、")}`);
    }
    const blindspots = (guide.blindspotCandidates ?? [])
      .filter((candidate) => candidate.importance !== "low")
      .slice(0, 3)
      .map((candidate) => `${candidate.concept}（${candidate.reason}）`);
    if (blindspots.length) {
      lines.push(`【盲区候选】（用户可能在回避或没意识到，值得自然地引向）：${blindspots.join("；")}`);
    }
    if (guide.recommendedPerspectives?.length) {
      lines.push(`【建议引入的认知视角】（以一个自然问题呈现，绝不要讲理论课）：${guide.recommendedPerspectives.slice(0, 3).join("、")}`);
    }
  }

  lines.push(
    "",
    "你的访谈动作库（每次开口都应属于其中之一，自然使用，不要报出动作名）：接住情绪、澄清歧义、追具体事实、追细节、追背后机制、追感受、追意义、追反复模式、挑战假设、引入反方、回访旧线索、镜像复述、从抽象切到具体、从具体抽到模式、阶段小结、留白等待。",
    "语言要求：每次只问一个核心问题；不要长篇总结；不要替用户下结论；可短暂复述用户原话但必须继续推进；当用户用抽象词（如'没办法''还好''差不多'）时，先把它问成一个具体时刻（谁、何时、哪句话）。",
    "输出只返回主持人的下一句中文追问，不要 Markdown，不要 JSON。",
    "",
    "在你的追问末尾，用 <pre_signals>...</pre_signals> 输出交互预判信号：",
    "",
    "<pre_signals>",
    "depth_direction:",
    "  concept: [基于上面的盲区候选、知识债、历史立场，判断下一轮最值得深挖的一个方向]",
    "  reason: [为什么这个方向值得深挖]",
    "  guidance: [一句邀请式引导话语，如'你刚才提到的X，能具体说说吗？']",
    "backchannel: [用户说这些时不打断，逗号分隔，如：嗯,对,是的,好]",
    "interrupt: [用户说这些时立即停止，逗号分隔，如：不对,等一下,我打断一下]",
    "sensitivity: [low/medium/high，基于话题重要性]",
    "</pre_signals>",
    "",
    "规则：depth_direction 只输出一条；guidance 必须是邀请式；sensitivity 根据话题重要性：盲区/知识债=low，闲聊=high；如果当前没有明确的深挖方向，depth_direction 可以为空。"
  );

  return lines.join("\n");
}

function extractOutputText(payload: BailianResponsesOutput) {
  if (payload.output_text) {
    return payload.output_text;
  }

  return (
    payload.output
      ?.flatMap((item) => item.content ?? [])
      .map((content) => content.text ?? "")
      .join("\n") ?? ""
  );
}

function parseSearchJson(text: string): BailianSearchJson {
  const trimmed = text.trim();
  const jsonText = trimmed.match(/```json\s*([\s\S]*?)```/)?.[1] ?? trimmed;

  try {
    return JSON.parse(jsonText) as BailianSearchJson;
  } catch {
    return {};
  }
}

function normalizeStringList(value: unknown, fallback: string[]) {
  if (!Array.isArray(value)) {
    return fallback;
  }

  const items = value.filter((item): item is string => typeof item === "string" && item.trim()).map((item) => item.trim());
  return items.length > 0 ? items : fallback;
}

function normalizeSources(value: unknown, input: BailianSearchBriefRequest): SourceHighlight[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.slice(0, input.maxSources).map((item, index) => {
    const source = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    const url = typeof source.url === "string" && source.url.trim() ? source.url.trim() : `https://dashscope.aliyun.com/search/${index + 1}`;

    return {
      id: `source-bailian-${Date.now()}-${index + 1}`,
      title: normalizeSourceText(source.title, `${input.topic}：百炼联网来源 ${index + 1}`),
      url,
      publisher: normalizeSourceText(source.publisher, "Bailian Web Search"),
      publishedAt: normalizeSourceText(source.publishedAt, new Date().toISOString()),
      snippet: normalizeSourceText(source.snippet, "百炼内置联网搜索返回的候选素材。"),
      relevanceScore: normalizeRelevanceScore(source.relevanceScore, index),
      usage: normalizeUsage(source.usage)
    };
  });
}

function normalizeSourceText(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function normalizeRelevanceScore(value: unknown, index: number) {
  const parsedValue = Number(value);
  if (Number.isFinite(parsedValue)) {
    return Math.max(0, Math.min(1, parsedValue));
  }
  return Math.max(0.5, 0.92 - index * 0.06);
}

function normalizeUsage(value: unknown): SourceHighlight["usage"] {
  return value === "interview-context" || value === "post-note-reference" ? value : "topic-suggestion";
}

function pickSuccessfulTranscriptionResult(value: unknown, sourceUrl: string): BailianTranscriptionResultItem | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const results = value
    .map((item) => (item && typeof item === "object" ? (item as BailianTranscriptionResultItem) : undefined))
    .filter((item): item is BailianTranscriptionResultItem => Boolean(item))
    .filter((item) => item.subtask_status === "SUCCEEDED");

  return (
    results.find((item) => typeof item.file_url === "string" && item.file_url.trim() === sourceUrl) ?? results[0]
  );
}

function extractTranscriptionText(payload: BailianTranscriptionJson) {
  const transcriptTexts =
    payload.transcripts?.flatMap((transcript) => {
      const sentenceTexts =
        transcript.sentences
          ?.map((sentence) => (typeof sentence.text === "string" ? sentence.text : ""))
          .filter(Boolean) ?? [];
      return sentenceTexts.length > 0 ? sentenceTexts : [typeof transcript.text === "string" ? transcript.text : ""];
    }) ?? [];

  return transcriptTexts
    .map(cleanSenseVoiceText)
    .filter(Boolean)
    .join("\n")
    .trim();
}

function cleanSenseVoiceText(value: string) {
  return value
    .replace(/<\|\/?[^|>]+\|>/g, "")
    .replace(/\|\/?[A-Z_]+\|/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeOptionalNumber(value: unknown) {
  const parsedValue = Number(value);
  return Number.isFinite(parsedValue) ? parsedValue : undefined;
}

function normalizeEnvInteger(value: string | undefined, fallback: number) {
  const parsedValue = Number(value);
  return Number.isInteger(parsedValue) && parsedValue >= 0 ? parsedValue : fallback;
}

function normalizeWebrtcSignalingUrl(endpoint: string) {
  const trimmedEndpoint = endpoint.replace(/\/$/, "");
  return trimmedEndpoint.endsWith("/api/v1/webrtc/realtime")
    ? trimmedEndpoint
    : `${trimmedEndpoint}/api/v1/webrtc/realtime`;
}

function delay(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export interface BailianVoiceInfo {
  voice: string;
  name: string;
  description: string;
  targetModel?: string;
  createdAt?: string;
}

export interface BailianVoiceEnrollmentClient {
  listVoices(): Promise<BailianVoiceInfo[]>;
  createVoice(input: { audioBase64: string; preferredName?: string }): Promise<BailianVoiceInfo>;
  deleteVoice(voiceId: string): Promise<void>;
}

export function createBailianVoiceEnrollmentClient(options: {
  apiKey: string;
  audioBaseUrl?: string;
  fetchImpl?: FetchLike;
}): BailianVoiceEnrollmentClient {
  const audioBaseUrl = (options.audioBaseUrl ?? BAILIAN_DEFAULT_AUDIO_BASE_URL).replace(/\/$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  const customizationUrl = `${audioBaseUrl}/api/v1/services/audio/tts/customization`;

  return {
    async listVoices() {
      const response = await fetchImpl(customizationUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: "qwen-voice-enrollment",
          input: {
            action: "list",
            page_size: 100,
            page_index: 0
          }
        })
      });

      if (!response.ok) {
        throw new Error(`Bailian voice list failed: ${response.status}`);
      }

      const payload = (await response.json()) as {
        output?: { voice_list?: Array<{ voice: string; target_model?: string; gmt_create?: string; preferred_name?: string }> };
      };

      return (payload.output?.voice_list ?? []).map((item) => ({
        voice: item.voice,
        name: item.preferred_name ?? item.voice,
        description: "",
        targetModel: item.target_model,
        createdAt: item.gmt_create
      }));
    },

    async createVoice(input) {
      const response = await fetchImpl(customizationUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: "qwen-voice-enrollment",
          input: {
            action: "create",
            audio: input.audioBase64,
            target_model: "qwen3.5-omni-plus-realtime",
            ...(input.preferredName ? { preferred_name: input.preferredName } : {})
          }
        })
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        throw new Error(`Bailian voice create failed: ${response.status} ${errorText}`);
      }

      const payload = (await response.json()) as {
        output?: { voice?: string; gmt_create?: string };
      };

      return {
        voice: payload.output?.voice ?? "",
        name: input.preferredName ?? payload.output?.voice ?? "",
        description: "",
        createdAt: payload.output?.gmt_create
      };
    },

    async deleteVoice(voiceId) {
      const response = await fetchImpl(customizationUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: "qwen-voice-enrollment",
          input: {
            action: "delete",
            voice: voiceId
          }
        })
      });

      if (!response.ok) {
        throw new Error(`Bailian voice delete failed: ${response.status}`);
      }
    }
  };
}

export function createBailianVoiceEnrollmentClientFromEnv(
  env: Record<string, string | undefined> = process.env
): BailianVoiceEnrollmentClient | undefined {
  const apiKey = env.DASHSCOPE_API_KEY ?? env.BAILIAN_API_KEY;
  if (!apiKey) return undefined;

  return createBailianVoiceEnrollmentClient({
    apiKey,
    audioBaseUrl: env.BAILIAN_AUDIO_BASE_URL
  });
}
