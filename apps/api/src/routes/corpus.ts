import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { sanitizeExternalMaterialText } from "../../../../src/domain/engine";
import type { AudioTranscription, AudioTranscriptionInput, CorpusImportInput } from "../../../../src/domain/types";
import { analyzeCorpusWithLlm } from "../intelligence/corpus-llm";
import { createLlmBudget, type LlmBudget } from "../llm-budget";
import { resolveCorpusUploadDir } from "../local-object-artifacts";
import type { BailianAudioTranscriptionClient, BailianChatClient } from "../providers/bailian";
import type { ProductStateRepository } from "../product-state-repository";
import { replaceStateDurable } from "../product-state-repository";
import { resolveCorpusAudioMaxBytes } from "../storage-config";
import { isAuthorized, readCookieToken } from "../auth";

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
  env?: Record<string, string | undefined>;
  /** Absolute public origin for local audio files (e.g. https://cdn.example.com). */
  corpusAudioPublicBaseUrl?: string;
  corpusUploadDir?: string;
}

export async function registerCorpusRoutes(
  server: FastifyInstance,
  repository: ProductStateRepository,
  options: CorpusRouteOptions = {}
) {
  const budget = options.llmBudget ?? createLlmBudget();
  const env = options.env ?? process.env;
  const uploadDir = resolveCorpusUploadDir({
    corpusUploadDir: options.corpusUploadDir,
    env,
    cwd: process.cwd()
  });
  const publicBase =
    (options.corpusAudioPublicBaseUrl ?? env.CORPUS_AUDIO_PUBLIC_BASE_URL ?? "").trim().replace(/\/+$/, "");

  // Authenticated (or local-open) static serve for files written under CORPUS_UPLOAD_DIR.
  // Required when CORPUS_AUDIO_PUBLIC_BASE_URL points back at this Product API so SenseVoice
  // (or any external ASR) can fetch the object via a real https/http URL.
  server.get("/api/corpus/audio-files/:fileName", async (request, reply) => {
    const params = request.params as { fileName?: string };
    const fileName = typeof params.fileName === "string" ? params.fileName : "";
    if (!fileName || fileName !== basenameSafe(fileName)) {
      return reply.code(400).send({ error: "Invalid audio file name." });
    }
    if (!isAuthorized(env, authPresentation(request))) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    const { createReadStream, existsSync, statSync } = await import("node:fs");
    const filePath = join(uploadDir, fileName);
    if (!existsSync(filePath)) {
      return reply.code(404).send({ error: "Audio file not found." });
    }
    const stat = statSync(filePath);
    const mime = mimeFromFileName(fileName);
    return reply
      .header("Content-Type", mime)
      .header("Content-Length", String(stat.size))
      .header("Cache-Control", "private, max-age=3600")
      .send(createReadStream(filePath));
  });


  /** Stage-2: store local audio only (no ASR). Returns local-object URL + optional public URL for CDN/SenseVoice. */
  server.post("/api/corpus/audio-files", async (request, reply) => {
    const payload = (request.body && typeof request.body === "object" ? request.body : {}) as {
      audioBase64?: unknown;
      fileName?: unknown;
    };
    const audioBase64 = typeof payload.audioBase64 === "string" ? payload.audioBase64.trim() : "";
    const fileName = typeof payload.fileName === "string" ? payload.fileName.trim() : "upload.audio";
    if (!audioBase64) {
      return reply.code(422).send({ error: "audioBase64 is required." });
    }
    if (audioBase64.length > MAX_AUDIO_BASE64_BYTES) {
      return reply.code(422).send({ error: "上传的音频文件过大（base64 超过 25 MB）。" });
    }
    let bytes: Buffer;
    try {
      bytes = Buffer.from(audioBase64, "base64");
    } catch {
      return reply.code(422).send({ error: "音频 base64 无法解码。" });
    }
    if (!bytes.length) {
      return reply.code(422).send({ error: "音频内容为空。" });
    }
    const maxBytes = resolveCorpusAudioMaxBytes(env);
    if (bytes.length > maxBytes) {
      return reply.code(413).send({ error: `音频文件超过 CORPUS_AUDIO_MAX_BYTES 上限（${maxBytes} 字节）。` });
    }
    const safeExt = sanitizeExtension(fileName);
    const digest = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
    const storedName = `${Date.now()}-${digest}${safeExt}`;
    mkdirSync(uploadDir, { recursive: true });
    writeFileSync(join(uploadDir, storedName), bytes);
    const localObjectUrl = `local-object://corpus-audio/${storedName}`;
    const publicUrl = publicBase
      ? publicBase.includes("/api/corpus/audio-files")
        ? `${publicBase.replace(/\/+$/, "")}/${encodeURIComponent(storedName)}`
        : `${publicBase}/api/corpus/audio-files/${encodeURIComponent(storedName)}`
      : undefined;
    return {
      storedFileName: storedName,
      localObjectUrl,
      ...(publicUrl ? { publicUrl } : {}),
      byteSize: bytes.length,
      publicBaseConfigured: Boolean(publicBase)
    };
  });

  server.post("/api/corpus/transcriptions", async (request, reply) => {
    const input = normalizeTranscriptionInput(request.body);

    // Local file upload branch.
    // SenseVoice only accepts publicly fetchable file_urls. When CORPUS_AUDIO_PUBLIC_BASE_URL
    // is set, we persist the bytes under CORPUS_UPLOAD_DIR and map them to a public URL so
    // ASR can pull them. Without that base URL we fail loud (422) — never fake a transcript.
    if (input.audioBase64) {
      if (input.audioBase64.length > MAX_AUDIO_BASE64_BYTES) {
        return reply
          .code(422)
          .send({ error: "上传的音频文件过大（base64 超过 25 MB），请压缩后重试或改用公网音频 URL。" });
      }

      let bytes: Buffer;
      try {
        bytes = Buffer.from(input.audioBase64, "base64");
      } catch {
        return reply.code(422).send({ error: "音频 base64 无法解码。" });
      }
      if (!bytes.length) {
        return reply.code(422).send({ error: "音频内容为空。" });
      }

      const maxBytes = resolveCorpusAudioMaxBytes(env);
      if (bytes.length > maxBytes) {
        return reply
          .code(413)
          .send({ error: `音频文件超过 CORPUS_AUDIO_MAX_BYTES 上限（${maxBytes} 字节）。` });
      }

      const fileLabel = input.fileName ?? "upload.audio";
      const safeExt = sanitizeExtension(fileLabel);
      const digest = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
      const storedName = `${Date.now()}-${digest}${safeExt}`;
      mkdirSync(uploadDir, { recursive: true });
      const filePath = join(uploadDir, storedName);
      writeFileSync(filePath, bytes);

      if (!publicBase) {
        const approxMb = (bytes.length / (1024 * 1024)).toFixed(1);
        return reply.code(422).send({
          error:
            `已保存本地文件「${fileLabel}」（约 ${approxMb} MB）到 ${uploadDir}，` +
            `但未配置 CORPUS_AUDIO_PUBLIC_BASE_URL，百炼 SenseVoice 无法拉取本地对象。` +
            `请设置可公网访问的基址（可指向本服务的 /api/corpus/audio-files），或直接粘贴转写稿 / 使用公网音频 URL。` +
            ` 本地引用：local-object://corpus-audio/${storedName}`
        });
      }

      if (!options.bailianTranscriptionClient) {
        return reply
          .code(503)
          .send({ error: "缺少 DASHSCOPE_API_KEY 或 BAILIAN_API_KEY，无法调用百炼 SenseVoice 录音转写。" });
      }

      const publicUrl = `${publicBase}/api/corpus/audio-files/${encodeURIComponent(storedName)}`;
      // If public base already includes the path prefix, avoid double /api/...
      const mappedUrl = publicBase.includes("/api/corpus/audio-files")
        ? `${publicBase.replace(/\/+$/, "")}/${encodeURIComponent(storedName)}`
        : publicUrl;

      try {
        const result = await options.bailianTranscriptionClient.transcribe({
          title: input.title,
          sourceUrl: mappedUrl,
          languageHint: input.languageHint
        });
        const transcription: AudioTranscription = {
          providerId: result.providerId,
          model: result.model,
          status: "ready",
          title: input.title,
          sourceUrl: mappedUrl,
          text: result.text,
          taskId: result.taskId,
          transcriptionUrl: result.transcriptionUrl,
          durationSec: result.durationSec,
          createdAt: new Date().toISOString()
        };
        return {
          transcription,
          localObjectUrl: `local-object://corpus-audio/${storedName}`,
          storedFileName: storedName
        };
      } catch (error) {
        const message = error instanceof Error && error.message ? error.message : "unknown error";
        console.warn(
          JSON.stringify({
            event: "transcription_failed",
            provider: "bailian-sensevoice",
            path: "local-upload",
            error: message,
            storedFileName: storedName
          })
        );
        return reply.code(502).send({
          error: `百炼 SenseVoice 转写失败：${message}（本地文件已保存为 local-object://corpus-audio/${storedName}）`
        });
      }
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

function authPresentation(request: FastifyRequest) {
  const q = request.query as { token?: string };
  return {
    authHeader: request.headers.authorization,
    tokenQuery: typeof q?.token === "string" ? q.token : undefined,
    cookieToken: readCookieToken(request.headers.cookie)
  };
}

function basenameSafe(name: string) {
  // Reject path traversal / empty / directory segments.
  if (!name || name.includes("/") || name.includes("\\") || name.includes("..")) return "";
  return name;
}

function sanitizeExtension(fileName: string) {
  const ext = extname(fileName).toLowerCase();
  const allowed = new Set([".wav", ".mp3", ".m4a", ".aac", ".ogg", ".flac", ".webm", ".mp4"]);
  return allowed.has(ext) ? ext : ".audio";
}

function mimeFromFileName(fileName: string) {
  const ext = extname(fileName).toLowerCase();
  const map: Record<string, string> = {
    ".wav": "audio/wav",
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".ogg": "audio/ogg",
    ".flac": "audio/flac",
    ".webm": "audio/webm",
    ".mp4": "audio/mp4"
  };
  return map[ext] ?? "application/octet-stream";
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
