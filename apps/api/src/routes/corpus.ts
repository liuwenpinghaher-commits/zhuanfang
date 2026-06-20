import type { FastifyInstance } from "fastify";
import { analyzeImportedInterview, sanitizeExternalMaterialText } from "../../../../src/domain/engine";
import type { AudioTranscription, AudioTranscriptionInput, CorpusImportInput } from "../../../../src/domain/types";
import { analyzeCorpusWithLlm } from "../intelligence/corpus-llm";
import { createLlmBudget, type LlmBudget } from "../llm-budget";
import type { BailianAudioTranscriptionClient, BailianChatClient } from "../providers/bailian";
import type { ProductStateRepository } from "../product-state-repository";

interface CorpusInsightRequestPayload {
  title?: unknown;
  mediaType?: unknown;
  content?: unknown;
  sourceUrl?: unknown;
  focus?: unknown;
}

interface CorpusTranscriptionRequestPayload {
  title?: unknown;
  sourceUrl?: unknown;
  languageHint?: unknown;
  audioBase64?: unknown;
  fileName?: unknown;
}

// Upper bound on a locally uploaded audio file's base64 payload. 25 MB of base64
// (~18 MB of raw audio) keeps a single JSON request reasonable; larger files should
// use a public URL.
const MAX_AUDIO_BASE64_BYTES = 25 * 1024 * 1024;

interface CorpusRouteOptions {
  bailianTranscriptionClient?: BailianAudioTranscriptionClient;
  bailianChatClient?: BailianChatClient;
  llmBudget?: LlmBudget;
}

export async function registerCorpusRoutes(
  server: FastifyInstance,
  repository: ProductStateRepository,
  options: CorpusRouteOptions = {}
) {
  const budget = options.llmBudget ?? createLlmBudget();

  server.post("/api/corpus/transcriptions", async (request, reply) => {
    const input = normalizeTranscriptionInput(request.body);

    // Local file upload branch. There is no inline-base64 transcription path on the
    // backend: SenseVoice 录音转写只接受公网 file_urls，唯一的 base64 音频能力是浏览器
    // 侧流式实时 ASR（omni-realtime，不是一次性的“收 base64 → 返回文字”接口）。因此我们
    // 诚实地确认收到文件并降级，绝不冒充真转写。
    if (input.audioBase64) {
      if (input.audioBase64.length > MAX_AUDIO_BASE64_BYTES) {
        return reply
          .code(422)
          .send({ error: "上传的音频文件过大（base64 超过 25 MB），请压缩后重试或改用公网音频 URL。" });
      }
      const approxMb = (estimateBase64Bytes(input.audioBase64) / (1024 * 1024)).toFixed(1);
      const fileLabel = input.fileName ?? "你上传的音频文件";
      return {
        transcription: buildLocalFileTranscription(input, fileLabel, approxMb)
      };
    }

    if (!input.sourceUrl) {
      return reply.code(422).send({ error: "Audio source URL or an uploaded audio file is required." });
    }

    if (!isSupportedAudioSourceUrl(input.sourceUrl)) {
      return reply.code(422).send({ error: "Audio source URL must use http, https, or oss protocol." });
    }

    if (!options.bailianTranscriptionClient) {
      return {
        transcription: buildFallbackTranscription(
          input,
          "缺少 DASHSCOPE_API_KEY 或 BAILIAN_API_KEY，无法调用百炼 SenseVoice 录音转写。"
        )
      };
    }

    try {
      const result = await options.bailianTranscriptionClient.transcribe(input);
      const transcription: AudioTranscription = {
        providerId: result.providerId,
        model: result.model,
        status: "ready",
        title: input.title,
        sourceUrl: result.sourceUrl,
        text: result.text,
        taskId: result.taskId,
        transcriptionUrl: result.transcriptionUrl,
        durationSec: result.durationSec,
        createdAt: new Date().toISOString()
      };
      return { transcription };
    } catch (error) {
      return {
        transcription: buildFallbackTranscription(
          input,
          error instanceof Error && error.message ? `百炼 SenseVoice 转写失败：${error.message}` : "百炼 SenseVoice 转写失败。"
        )
      };
    }
  });

  server.post("/api/corpus/insights", async (request, reply) => {
    const input = normalizeCorpusInput(request.body);
    if (!input.content.trim()) {
      return reply.code(422).send({ error: "Corpus content is required." });
    }
    const focus = normalizeFocus(request.body);

    const state = repository.getState();
    const allowLlm = !!options.bailianChatClient && budget.tryConsume("system");
    if (!!options.bailianChatClient && !allowLlm) {
      console.warn(JSON.stringify({ event: "llm_budget_exceeded", capability: "corpus_insights" }));
    }
    const { insight, nextState } = await analyzeCorpus(state, input, allowLlm ? options.bailianChatClient : undefined, focus);
    repository.replaceState(nextState);
    return { insight, state: nextState };
  });
}

async function analyzeCorpus(
  state: Parameters<typeof analyzeImportedInterview>[0],
  input: CorpusImportInput,
  chatClient: BailianChatClient | undefined,
  focus?: string
) {
  if (chatClient) {
    try {
      return await analyzeCorpusWithLlm(state, input, chatClient, focus);
    } catch (error) {
      console.warn(JSON.stringify({ event: "llm_fallback", capability: "corpus", error: error instanceof Error ? error.message : String(error) }));
    }
  }
  // Deterministic path ignores focus (the templated analyzer does not use free-form
  // guidance); it must still succeed when focus is supplied.
  return analyzeImportedInterview(state, input);
}

function normalizeFocus(value: unknown): string | undefined {
  const payload = normalizePayload(value);
  if (typeof payload.focus !== "string" || !payload.focus.trim()) {
    return undefined;
  }
  // focus is interpolated straight into the LLM prompt — sanitize it like other external
  // material so it can't smuggle instruction-injection text.
  return sanitizeExternalMaterialText(payload.focus.trim(), payload.focus.trim());
}

function normalizeCorpusInput(value: unknown): CorpusImportInput {
  const payload = normalizePayload(value);
  return {
    title: normalizeText(payload.title, "未命名专访样本"),
    mediaType: payload.mediaType === "audio" ? "audio" : "text",
    content: normalizeText(payload.content, ""),
    sourceUrl: typeof payload.sourceUrl === "string" && payload.sourceUrl.trim() ? payload.sourceUrl.trim() : undefined
  };
}

function normalizeTranscriptionInput(value: unknown): AudioTranscriptionInput {
  const payload = normalizeTranscriptionPayload(value);
  const audioBase64 = typeof payload.audioBase64 === "string" && payload.audioBase64.trim() ? payload.audioBase64.trim() : undefined;
  const fileName = typeof payload.fileName === "string" && payload.fileName.trim() ? payload.fileName.trim() : undefined;
  return {
    title: normalizeText(payload.title, "未命名音频专访样本"),
    sourceUrl: typeof payload.sourceUrl === "string" && payload.sourceUrl.trim() ? payload.sourceUrl.trim() : "",
    languageHint: typeof payload.languageHint === "string" && payload.languageHint.trim() ? payload.languageHint.trim() : undefined,
    ...(audioBase64 ? { audioBase64 } : {}),
    ...(fileName ? { fileName } : {})
  };
}

/** Approximate decoded byte length of a base64 string (ignoring padding). */
function estimateBase64Bytes(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

function normalizePayload(value: unknown): CorpusInsightRequestPayload {
  if (!value || typeof value !== "object") {
    return {};
  }
  return value as CorpusInsightRequestPayload;
}

function normalizeTranscriptionPayload(value: unknown): CorpusTranscriptionRequestPayload {
  if (!value || typeof value !== "object") {
    return {};
  }
  return value as CorpusTranscriptionRequestPayload;
}

function normalizeText(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function isSupportedAudioSourceUrl(sourceUrl: string) {
  return /^(https?:\/\/|oss:\/\/)/.test(sourceUrl);
}

function buildFallbackTranscription(input: AudioTranscriptionInput, degradedReason: string): AudioTranscription {
  return {
    providerId: "local-fallback",
    model: "manual-transcript-required",
    status: "degraded",
    title: input.title,
    sourceUrl: input.sourceUrl,
    text: [
      `主持人：这段音频来自 ${input.sourceUrl}，当前还没有完成自动转写。`,
      "被访者：请先补充这段专访里最关键的回答、原话和停顿。",
      "主持人：补齐后我会重点分析它如何索要具体时刻、推动反方观点，以及控制追问节奏。"
    ].join("\n"),
    degradedReason,
    createdAt: new Date().toISOString()
  };
}

/**
 * Honest degradation for a locally uploaded audio file. We acknowledge the exact
 * file we received, then state plainly that automatic transcription needs a public
 * URL — and seed an editable draft that carries the file name into context. This is
 * a deliberate constraint of SenseVoice 录音转写 (file_urls only); we never return a
 * fabricated transcript dressed up as the real thing.
 */
function buildLocalFileTranscription(
  input: AudioTranscriptionInput,
  fileLabel: string,
  approxMb: string
): AudioTranscription {
  return {
    providerId: "local-fallback",
    model: "manual-transcript-required",
    status: "degraded",
    title: input.title,
    sourceUrl: input.sourceUrl,
    text: [
      `主持人：这段专访音频来自本地文件「${fileLabel}」，目前还没有自动转写。`,
      "被访者：请在这里补充被访者的关键原话、停顿和情绪变化。",
      "主持人：补齐后我会分析这段专访如何索要具体时刻、推进反方观点和控制节奏。"
    ].join("\n"),
    degradedReason: `已接收文件「${fileLabel}」（约 ${approxMb} MB）。当前转写引擎（百炼 SenseVoice）需要可公网访问的音频 URL，本地文件暂不能自动转写——请直接粘贴/手敲转写稿，或改用公网音频 URL。`,
    createdAt: new Date().toISOString()
  };
}
