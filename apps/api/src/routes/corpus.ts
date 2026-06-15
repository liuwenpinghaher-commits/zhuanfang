import type { FastifyInstance } from "fastify";
import { analyzeImportedInterview } from "../../../../src/domain/engine";
import type { AudioTranscription, AudioTranscriptionInput, CorpusImportInput } from "../../../../src/domain/types";
import { analyzeCorpusWithLlm } from "../intelligence/corpus-llm";
import type { BailianAudioTranscriptionClient, BailianChatClient } from "../providers/bailian";
import type { ProductStateRepository } from "../product-state-repository";

interface CorpusInsightRequestPayload {
  title?: unknown;
  mediaType?: unknown;
  content?: unknown;
  sourceUrl?: unknown;
}

interface CorpusTranscriptionRequestPayload {
  title?: unknown;
  sourceUrl?: unknown;
  languageHint?: unknown;
}

interface CorpusRouteOptions {
  bailianTranscriptionClient?: BailianAudioTranscriptionClient;
  bailianChatClient?: BailianChatClient;
}

export async function registerCorpusRoutes(
  server: FastifyInstance,
  repository: ProductStateRepository,
  options: CorpusRouteOptions = {}
) {
  server.post("/api/corpus/transcriptions", async (request, reply) => {
    const input = normalizeTranscriptionInput(request.body);
    if (!input.sourceUrl) {
      return reply.code(422).send({ error: "Audio source URL is required." });
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

    const state = repository.getState();
    const { insight, nextState } = await analyzeCorpus(state, input, options.bailianChatClient);
    repository.replaceState(nextState);
    return { insight, state: nextState };
  });
}

async function analyzeCorpus(
  state: Parameters<typeof analyzeImportedInterview>[0],
  input: CorpusImportInput,
  chatClient: BailianChatClient | undefined
) {
  if (chatClient) {
    try {
      return await analyzeCorpusWithLlm(state, input, chatClient);
    } catch (error) {
      console.warn(JSON.stringify({ event: "llm_fallback", capability: "corpus", error: error instanceof Error ? error.message : String(error) }));
    }
  }
  return analyzeImportedInterview(state, input);
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
  return {
    title: normalizeText(payload.title, "未命名音频专访样本"),
    sourceUrl: typeof payload.sourceUrl === "string" && payload.sourceUrl.trim() ? payload.sourceUrl.trim() : "",
    languageHint: typeof payload.languageHint === "string" && payload.languageHint.trim() ? payload.languageHint.trim() : undefined
  };
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
