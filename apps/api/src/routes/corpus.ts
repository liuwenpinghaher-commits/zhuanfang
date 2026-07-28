import type { FastifyInstance } from "fastify";
import { sanitizeExternalMaterialText } from "../../../../src/domain/engine";
import type { AudioTranscription, AudioTranscriptionInput, CorpusImportInput } from "../../../../src/domain/types";
import { analyzeCorpusWithLlm } from "../intelligence/corpus-llm";
import { createLlmBudget, type LlmBudget } from "../llm-budget";
import type { BailianAudioTranscriptionClient, BailianChatClient } from "../providers/bailian";
import type { ProductStateRepository } from "../product-state-repository";
import { replaceStateDurable } from "../product-state-repository";

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
    // 侧流式实时 ASR（omni-realtime，不是一次性的“收 base64 → 返回文字”接口）。这是
    // 能力边界——如实拒绝，绝不返回占位稿冒充转写。
    if (input.audioBase64) {
      if (input.audioBase64.length > MAX_AUDIO_BASE64_BYTES) {
        return reply
          .code(422)
          .send({ error: "上传的音频文件过大（base64 超过 25 MB），请压缩后重试或改用公网音频 URL。" });
      }
      const approxMb = (estimateBase64Bytes(input.audioBase64) / (1024 * 1024)).toFixed(1);
      const fileLabel = input.fileName ?? "你上传的音频文件";
      return reply.code(422).send({
        error: `已接收文件「${fileLabel}」（约 ${approxMb} MB），但当前转写引擎（百炼 SenseVoice）只支持可公网访问的音频 URL，本地文件无法自动转写。请直接粘贴转写稿，或改用公网音频 URL。`
      });
    }

    if (!input.sourceUrl) {
      return reply.code(422).send({ error: "Audio source URL or an uploaded audio file is required." });
    }

    if (!isSupportedAudioSourceUrl(input.sourceUrl)) {
      return reply.code(422).send({ error: "Audio source URL must use http, https, or oss protocol." });
    }

    if (!options.bailianTranscriptionClient) {
      return reply.code(503).send({ error: "缺少 DASHSCOPE_API_KEY 或 BAILIAN_API_KEY，无法调用百炼 SenseVoice 录音转写。" });
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
      const message = error instanceof Error && error.message ? error.message : "unknown error";
      console.warn(JSON.stringify({ event: "transcription_failed", provider: "bailian-sensevoice", error: message }));
      return reply.code(502).send({ error: `百炼 SenseVoice 转写失败：${message}` });
    }
  });

  server.post("/api/corpus/insights", async (request, reply) => {
    const input = normalizeCorpusInput(request.body);
    // 审计修复(P3-40):与 /api/import/documents 的 256KB 护栏对齐(此前 corpus content 无单字段
    // 上限且 content+turns 双份入 state,粘贴 5-10MB 逐字稿直逼 28MB PUT 墙)。
    if (input.content.length > CORPUS_CONTENT_MAX_CHARS) {
      return reply.code(422).send({ error: `语料内容超出 ${CORPUS_CONTENT_MAX_CHARS} 字上限。` });
    }
    if (!input.content.trim()) {
      return reply.code(422).send({ error: "Corpus content is required." });
    }
    const focus = normalizeFocus(request.body);

    // 语料分析是 LLM 能力：不可用就如实暴露，绝不回落到关键词模板分析冒充。
    if (!options.bailianChatClient) {
      return reply.code(503).send({ error: "语料分析 LLM 未配置（缺少 DASHSCOPE_API_KEY），无法分析样本。" });
    }
    if (!budget.tryConsume("system")) {
      console.warn(JSON.stringify({ event: "llm_budget_exceeded", capability: "corpus_insights" }));
      return reply.code(429).send({ error: "本时段 LLM 预算已用尽，语料分析暂不可用，请稍后重试。" });
    }

    const state = repository.getState();
    let analyzed: Awaited<ReturnType<typeof analyzeCorpusWithLlm>>;
    try {
      analyzed = await analyzeCorpusWithLlm(state, input, options.bailianChatClient, focus);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(JSON.stringify({ event: "llm_failed", capability: "corpus", error: message }));
      return reply.code(502).send({ error: `语料分析失败：${message}` });
    }
    // state 必须是 replaceState 返回的权威态(revision 已 bump),否则客户端下一次乐观 PUT 必 409。
    const persisted = await replaceStateDurable(repository, analyzed.nextState);
    return { insight: analyzed.insight, state: persisted };
  });
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

// 审计修复(P3-40):与 IMPORT_CONTENT_MAX_CHARS 同量级。
const CORPUS_CONTENT_MAX_CHARS = 256 * 1024;

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

