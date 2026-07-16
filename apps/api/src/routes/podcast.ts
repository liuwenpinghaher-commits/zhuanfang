import type { FastifyInstance } from "fastify";
import {
  generatePodcastEpisode,
  generatePodcastEpisodeFromKnowledgeDebt,
  generatePodcastEpisodeFromSearchBrief,
  generatePodcastEpisodeFromTheme
} from "../../../../src/domain/engine";
import type { PodcastEpisode } from "../../../../src/domain/types";
import { createLlmBudget, type LlmBudget } from "../llm-budget";
import type { BailianChatClient, BailianPodcastAudioClient } from "../providers/bailian";
import type { ProductStateRepository } from "../product-state-repository";
import { generatePodcastScript } from "../intelligence/podcast-script-llm";

interface PodcastEpisodeRequestPayload {
  noteId?: unknown;
  sourceType?: unknown;
  sourceId?: unknown;
  format?: unknown;
  voice?: unknown;
}

interface PodcastRouteOptions {
  bailianPodcastAudioClient?: BailianPodcastAudioClient;
  bailianChatClient?: BailianChatClient;
  llmBudget?: LlmBudget;
}

/**
 * Renders TTS audio for a given episode using its current script.
 * Returns a patch object with the updated audio fields.
 * TTS 失败如实标记为 "failed" 并携带真实错误信息（脚本已持久化不受影响），
 * 绝不伪装成可稍后自动恢复的中间态。调用方（synthesize 端点）据此返回 5xx。
 */
export async function renderEpisodeAudio(
  episode: PodcastEpisode,
  audioClient: BailianPodcastAudioClient
): Promise<Partial<PodcastEpisode>> {
  try {
    const renderedAudio = await audioClient.synthesize({
      text: episode.script,
      voice: normalizeProviderVoice(episode.voice)
    });
    return {
      audioUrl: renderedAudio.audioUrl,
      durationSec: renderedAudio.durationSec ?? episode.durationSec,
      voice: renderedAudio.voice,
      audioRenderStatus: "rendered",
      audioRenderMessage: "音频已渲染。",
      // 审计修复(P3-31):provider 返回的过期时间此前被丢弃、audioExpiresAt 字段全库零写入
      // → 次日播放 403 无过期语义。落地为 ISO(expiresAt 是秒级 epoch)。
      ...(typeof renderedAudio.expiresAt === "number"
        ? { audioExpiresAt: new Date(renderedAudio.expiresAt * 1000).toISOString() }
        : {})
    };
  } catch (ttsError) {
    const message = ttsError instanceof Error ? ttsError.message : String(ttsError);
    console.warn(
      JSON.stringify({
        event: "tts_failed",
        capability: "podcast_tts",
        error: message
      })
    );
    return {
      audioRenderStatus: "failed",
      audioRenderMessage: `音频渲染失败：${message}。脚本已保留，可稍后重试。`
    };
  }
}

export async function registerPodcastRoutes(
  server: FastifyInstance,
  repository: ProductStateRepository,
  options: PodcastRouteOptions = {}
) {
  const budget = options.llmBudget ?? createLlmBudget();

  server.post("/api/podcast/episodes", async (request, reply) => {
    const state = repository.getState();
    const payload = normalizePayload(request.body);
    const sourceType = normalizeSourceType(payload.sourceType);
    const sourceId = typeof payload.sourceId === "string" && payload.sourceId ? payload.sourceId : undefined;
    const noteId = typeof payload.noteId === "string" && payload.noteId ? payload.noteId : state.notes[0]?.id;
    const format = normalizeFormat(payload.format);
    const voice =
      typeof payload.voice === "string" && payload.voice.trim()
        ? payload.voice.trim()
        : state.systemConfig.voice.podcastVoice;

    let episode: PodcastEpisode;
    let nextState: ReturnType<typeof repository.getState>;

    if (sourceType === "search-brief" && sourceId) {
      const brief = state.searchBriefs.find((b: any) => b.id === sourceId);
      if (!brief) {
        return reply.code(422).send({ error: "Search brief not found." });
      }
      ({ episode, nextState } = generatePodcastEpisodeFromSearchBrief(state, sourceId, { format, voice }));
    } else if (sourceType === "theme" && sourceId) {
      const theme = state.themes.find((t: any) => t.id === sourceId);
      if (!theme) {
        return reply.code(422).send({ error: "Theme not found." });
      }
      ({ episode, nextState } = generatePodcastEpisodeFromTheme(state, sourceId, { format, voice }));
    } else if (sourceType === "knowledge-debt" && sourceId) {
      const debt = state.debts.find((d: any) => d.id === sourceId);
      if (!debt) {
        return reply.code(422).send({ error: "Knowledge debt not found." });
      }
      ({ episode, nextState } = generatePodcastEpisodeFromKnowledgeDebt(state, sourceId, { format, voice }));
    } else {
      if (!noteId) {
        return reply.code(422).send({ error: "No notes are available for podcast generation." });
      }
      // Note 路径的脚本是 LLM 能力：不可用/失败就如实暴露，绝不用确定性模板脚本冒充。
      if (!options.bailianChatClient) {
        return reply.code(503).send({ error: "播客脚本 LLM 未配置（缺少 DASHSCOPE_API_KEY），无法从笔记生成播客。" });
      }
      if (!budget.tryConsume("system")) {
        console.warn(JSON.stringify({ event: "llm_budget_exceeded", capability: "podcast_script" }));
        return reply.code(429).send({ error: "本时段 LLM 预算已用尽，播客脚本生成暂不可用，请稍后重试。" });
      }
      const note = state.notes.find((n) => n.id === noteId);
      if (!note) {
        return reply.code(422).send({ error: "Note not found." });
      }
      ({ episode, nextState } = generatePodcastEpisode(state, noteId, { format, voice }));
      let llmScript: string;
      try {
        llmScript = await generatePodcastScript({ note, format }, options.bailianChatClient);
      } catch (llmError) {
        const message = llmError instanceof Error ? llmError.message : String(llmError);
        console.warn(JSON.stringify({ event: "llm_failed", capability: "podcast_script", error: message }));
        return reply.code(502).send({ error: `播客脚本生成失败：${message}` });
      }
      episode = {
        ...episode,
        script: llmScript,
        durationSec: Math.max(180, Math.round(llmScript.length * 0.8))
      };
      nextState = {
        ...nextState,
        podcastEpisodes: nextState.podcastEpisodes.map((item) =>
          item.id === episode.id ? episode : item
        )
      };
    }

    // --- Step 1: Persist the episode FIRST (script is now saved, TTS failure won't lose it) ---
    // state 必须是 replaceState 返回的权威态(revision 已 bump),否则客户端下一次乐观 PUT 必 409。
    const persistedDraft = repository.replaceState(nextState);

    // --- Step 2: If no TTS client, return the persisted episode as-is (audioRenderStatus
    // stays "pending" — 尚未渲染是诚实状态；配置 TTS 后可显式 synthesize) ---
    if (!options.bailianPodcastAudioClient) {
      return { episode, state: persistedDraft };
    }

    // --- Step 3: Attempt TTS; failure is persisted as "failed" with the real error,
    // never dressed up as a recoverable in-between state ---
    const audioPatch = await renderEpisodeAudio(episode, options.bailianPodcastAudioClient);
    const finalEpisode: PodcastEpisode = { ...episode, ...audioPatch };

    const finalState = {
      ...nextState,
      podcastEpisodes: nextState.podcastEpisodes.map((item) =>
        item.id === episode.id ? finalEpisode : item
      )
    };
    const persistedFinal = repository.replaceState(finalState);
    return { episode: finalEpisode, state: persistedFinal };
  });

  // POST /api/podcast/episodes/:id/synthesize
  // Re-renders TTS for an already-persisted episode.
  // Optional body: { script?: string } — when provided, the episode.script is updated to
  // the caller-supplied value BEFORE rendering, eliminating the frontend save-then-synthesize
  // race condition (the client can pass the current editing script directly).
  // When omitted, falls back to the stored episode.script.
  // TTS 不可用/失败如实返回 503/502（用户提供的脚本仍会持久化，不丢内容）。
  server.post("/api/podcast/episodes/:id/synthesize", async (request, reply) => {
    const { id } = request.params as { id: string };
    const state = repository.getState();
    const existing = state.podcastEpisodes.find((ep) => ep.id === id);
    if (!existing) {
      return reply.code(404).send({ error: "Episode not found." });
    }

    // If the caller supplies a script, use it (and persist it) instead of the stored one.
    const body = request.body && typeof request.body === "object" ? (request.body as Record<string, unknown>) : {};
    const incomingScript = typeof body.script === "string" && body.script.trim() ? body.script : undefined;
    const episodeToRender: PodcastEpisode = incomingScript
      ? { ...existing, script: incomingScript, scriptReviewStatus: "用户确认" }
      : existing;

    if (!options.bailianPodcastAudioClient) {
      // 用户显式要求合成——没有 TTS 就是不能用，如实 503。先保住用户带来的脚本编辑。
      if (incomingScript) {
        repository.replaceState({
          ...state,
          podcastEpisodes: state.podcastEpisodes.map((ep) => (ep.id === id ? episodeToRender : ep))
        });
      }
      return reply.code(503).send({ error: "未配置 TTS 服务（缺少 DASHSCOPE_API_KEY），无法合成音频。脚本已保留。" });
    }

    const audioPatch = await renderEpisodeAudio(episodeToRender, options.bailianPodcastAudioClient);
    const updatedEpisode: PodcastEpisode = {
      ...episodeToRender,
      ...audioPatch,
      scriptReviewStatus: "用户确认",
      status: "ready"
    };

    const updatedState = {
      ...state,
      podcastEpisodes: state.podcastEpisodes.map((ep) =>
        ep.id === id ? updatedEpisode : ep
      )
    };
    const persisted = repository.replaceState(updatedState);
    if (updatedEpisode.audioRenderStatus === "failed") {
      // 渲染失败：脚本与失败状态已持久化（不丢内容），HTTP 层如实 502 并附上权威 state
      // 供客户端同步 revision。
      return reply.code(502).send({
        error: updatedEpisode.audioRenderMessage ?? "音频渲染失败。",
        episode: updatedEpisode,
        state: persisted
      });
    }
    return { episode: updatedEpisode, state: persisted };
  });
}

function normalizePayload(value: unknown): PodcastEpisodeRequestPayload {
  if (!value || typeof value !== "object") {
    return {};
  }
  return value as PodcastEpisodeRequestPayload;
}

function normalizeSourceType(value: unknown): PodcastEpisode["sourceType"] {
  if (value === "search-brief" || value === "theme" || value === "knowledge-debt") {
    return value;
  }
  return "note";
}

function normalizeFormat(value: unknown): PodcastEpisode["format"] {
  return value === "host-guest" ? "host-guest" : "solo";
}

function normalizeProviderVoice(voice: string) {
  return voice === "calm-host" || voice === "warm-interviewer" ? undefined : voice;
}
