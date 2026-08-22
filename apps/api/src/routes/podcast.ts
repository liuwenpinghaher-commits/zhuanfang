import type { FastifyInstance } from "fastify";
import {
  confirmPodcastScript,
  generatePodcastEpisode,
  generatePodcastEpisodeFromKnowledgeDebt,
  generatePodcastEpisodeFromSearchBrief,
  generatePodcastEpisodeFromTheme,
  prependPodcastEpisode,
  replacePodcastEpisode,
  withGeneratedArtifactWorkflowRun
} from "../../../../src/domain/engine";
import { deletePodcastEpisode } from "../../../../src/domain/lifecycle";
import type { PodcastEpisode, ProductState } from "../../../../src/domain/types";
import { makeId, withAiRunEvent, withAuditEvent } from "../../../../src/domain/utils";
import { createLlmBudget, type LlmBudget } from "../llm-budget";
import type { BailianChatClient, BailianPodcastAudioClient } from "../providers/bailian";
import type { ProductStateRepository } from "../product-state-repository";
import { generatePodcastScriptFromSource } from "../intelligence/podcast-script-llm";
import { normalizeCosyVoiceId } from "../voice-presets";
import { runStateCommand } from "../state-command";
import type { WriteGate } from "../server";

const PODCAST_SCRIPT_MAX_CHARS = 32_000;

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
  writeGate?: WriteGate;
}

type PodcastScriptSource =
  | { kind: "note"; note: ProductState["notes"][number]; format: PodcastEpisode["format"] }
  | { kind: "search-brief"; brief: ProductState["searchBriefs"][number]; format: PodcastEpisode["format"] }
  | { kind: "theme"; theme: ProductState["themes"][number]; format: PodcastEpisode["format"] }
  | { kind: "knowledge-debt"; debt: ProductState["debts"][number]; format: PodcastEpisode["format"] };

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
  const writeOpts = { writeGate: options.writeGate };

  server.post("/api/podcast/episodes", async (request, reply) => {
    const state = repository.getState();
    const payload = normalizePayload(request.body);
    const sourceType = normalizeSourceType(payload.sourceType);
    const sourceId = typeof payload.sourceId === "string" && payload.sourceId ? payload.sourceId : undefined;
    const noteId = typeof payload.noteId === "string" && payload.noteId ? payload.noteId : state.notes[0]?.id;
    const format = normalizeFormat(payload.format);
    const voice = normalizeCosyVoiceId(
      typeof payload.voice === "string" && payload.voice.trim()
        ? payload.voice.trim()
        : state.systemConfig.voice.podcastVoice
    );

    if (!options.bailianChatClient) {
      return reply.code(503).send({ error: "播客脚本 LLM 未配置（缺少 DASHSCOPE_API_KEY），无法生成播客。" });
    }

    const resolved = resolveScriptSource(state, sourceType, sourceId, noteId, format);
    if (!resolved.ok) {
      return reply.code(resolved.code).send({ error: resolved.error });
    }
    const scriptSource = resolved.scriptSource;

    if (!budget.tryConsume("system")) {
      console.warn(JSON.stringify({ event: "llm_budget_exceeded", capability: "podcast_script" }));
      return reply.code(429).send({ error: "本时段 LLM 预算已用尽，播客脚本生成暂不可用，请稍后重试。" });
    }

    const episodeId = makeId("podcast");

    let llmScript: string;
    try {
      llmScript = await generatePodcastScriptFromSource(scriptSource, options.bailianChatClient);
    } catch (llmError) {
      const message = llmError instanceof Error ? llmError.message : String(llmError);
      console.warn(JSON.stringify({ event: "llm_failed", capability: "podcast_script", error: message, sourceType }));
      return reply.code(502).send({ error: `播客脚本生成失败：${message}` });
    }

    const skeleton = buildEpisodeSkeleton(repository.getState(), scriptSource, voice);
    const episode: PodcastEpisode = {
      ...skeleton,
      id: episodeId,
      script: llmScript,
      durationSec: Math.max(180, Math.round(llmScript.length * 0.8))
    };

    let failure: { code: number; error: string } | null = null;
    let created: PodcastEpisode | undefined;
    const persistedDraft = await runStateCommand(
      repository,
      (latest) => {
        failure = null;
        created = undefined;
        const still = resolveScriptSource(latest, sourceType, sourceId, noteId, format);
        if (!still.ok) {
          failure = { code: still.code, error: still.error };
          return null;
        }
        const existing = latest.podcastEpisodes.find((item) => item.id === episodeId);
        if (existing) {
          created = existing;
          return latest;
        }
        const next = withPodcastCreatedEvents(prependPodcastEpisode(latest, episode), episode);
        created = episode;
        return next;
      },
      { ...writeOpts, label: `command:podcast-create:${episodeId}` }
    );
    if (!persistedDraft || !created) {
      const f = failure ?? { code: 500, error: "播客脚本未能保存。" };
      return reply.code(f.code).send({ error: f.error });
    }

    if (!options.bailianPodcastAudioClient) {
      return { episode: created, state: persistedDraft };
    }

    if (!shouldAutoRenderPodcastOnCreate(process.env.PODCAST_AUTO_RENDER_ON_CREATE)) {
      return { episode: created, state: persistedDraft };
    }

    const audioPatch = await renderEpisodeAudio(created, options.bailianPodcastAudioClient);
    let autoFailure: { code: number; error: string } | null = null;
    let autoEpisode: PodcastEpisode | undefined;
    const persistedFinal = await runStateCommand(
      repository,
      (latest) => {
        autoFailure = null;
        autoEpisode = undefined;
        const current = latest.podcastEpisodes.find((item) => item.id === episodeId);
        if (!current) {
          autoFailure = { code: 404, error: "Episode not found." };
          return null;
        }
        const finalEpisode: PodcastEpisode = { ...current, ...audioPatch };
        autoEpisode = finalEpisode;
        return replacePodcastEpisode(latest, finalEpisode);
      },
      { ...writeOpts, label: `command:podcast-auto-render:${episodeId}` }
    );
    if (!persistedFinal || !autoEpisode) {
      const f = autoFailure ?? { code: 500, error: "播客音频未能保存。" };
      return reply.code(f.code).send({ error: f.error });
    }
    return { episode: autoEpisode, state: persistedFinal };
  });

  server.post("/api/podcast/episodes/:id/confirm", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body && typeof request.body === "object" ? (request.body as Record<string, unknown>) : {};
    const incomingScript = typeof body.script === "string" ? body.script : undefined;
    if (incomingScript !== undefined && incomingScript.trim().length > PODCAST_SCRIPT_MAX_CHARS) {
      return reply.code(422).send({ error: "口播稿超过 32000 字上限。" });
    }

    let failure: { code: number; error: string } | null = null;
    let confirmed: PodcastEpisode | undefined;
    const persisted = await runStateCommand(
      repository,
      (state) => {
        failure = null;
        confirmed = undefined;
        const existing = state.podcastEpisodes.find((ep) => ep.id === id);
        if (!existing) {
          failure = { code: 404, error: "Episode not found." };
          return null;
        }
        const nextScript = (incomingScript ?? existing.script).trim();
        if (!nextScript) {
          failure = { code: 422, error: "口播稿不能为空。" };
          return null;
        }
        if (nextScript.length > PODCAST_SCRIPT_MAX_CHARS) {
          failure = { code: 422, error: "口播稿超过 32000 字上限。" };
          return null;
        }
        const next = confirmPodcastScript(state, id, nextScript);
        if (!next) {
          failure = { code: 422, error: "口播稿不能为空。" };
          return null;
        }
        confirmed = next.podcastEpisodes.find((ep) => ep.id === id);
        return next;
      },
      { ...writeOpts, label: `command:podcast-script-confirm:${id}` }
    );
    if (!persisted || !confirmed) {
      const f = failure ?? { code: 500, error: "口播稿未能确认。" };
      return reply.code(f.code).send({ error: f.error });
    }
    return { episode: confirmed, state: persisted };
  });

  server.post("/api/podcast/episodes/:id/synthesize", async (request, reply) => {
    const { id } = request.params as { id: string };
    const requireConfirm = shouldRequirePodcastConfirmOnSynthesize(process.env.PODCAST_SYNTHESIZE_REQUIRES_CONFIRM);
    const body = request.body && typeof request.body === "object" ? (request.body as Record<string, unknown>) : {};
    const incomingScript = typeof body.script === "string" && body.script.trim() ? body.script : undefined;

    if (requireConfirm) {
      const current = repository.getState().podcastEpisodes.find((ep) => ep.id === id);
      if (!current) {
        return reply.code(404).send({ error: "Episode not found." });
      }
      if (current.scriptReviewStatus !== "用户确认") {
        return reply.code(409).send({ error: "脚本尚未确认，确认后再合成。" });
      }
      if (incomingScript && incomingScript !== current.script) {
        return reply.code(409).send({ error: "稿已改动，请先确认后再合成。" });
      }
      if (!options.bailianPodcastAudioClient) {
        return reply.code(503).send({ error: "未配置 TTS 服务（缺少 DASHSCOPE_API_KEY），无法合成音频。脚本已保留。" });
      }

      const episodeToRender = current;
      const audioPatch = await renderEpisodeAudio(episodeToRender, options.bailianPodcastAudioClient);
      return commitSynthesizePatch(repository, reply, writeOpts, {
        id,
        expectedScript: episodeToRender.script,
        audioPatch
      });
    }

    const existing = repository.getState().podcastEpisodes.find((ep) => ep.id === id);
    if (!existing) {
      return reply.code(404).send({ error: "Episode not found." });
    }
    const episodeToRender: PodcastEpisode = incomingScript
      ? { ...existing, script: incomingScript, scriptReviewStatus: "用户确认" }
      : existing;

    if (!options.bailianPodcastAudioClient) {
      if (incomingScript) {
        const persistedScript = await runStateCommand(
          repository,
          (latest) => {
            const current = latest.podcastEpisodes.find((ep) => ep.id === id);
            if (!current) return null;
            return replacePodcastEpisode(latest, {
              ...current,
              script: incomingScript,
              scriptReviewStatus: "用户确认"
            });
          },
          { ...writeOpts, label: `command:podcast-synthesize-script:${id}` }
        );
        if (!persistedScript) {
          return reply.code(404).send({ error: "Episode not found." });
        }
      }
      return reply.code(503).send({ error: "未配置 TTS 服务（缺少 DASHSCOPE_API_KEY），无法合成音频。脚本已保留。" });
    }

    const audioPatch = await renderEpisodeAudio(episodeToRender, options.bailianPodcastAudioClient);
    return commitSynthesizePatch(repository, reply, writeOpts, {
      id,
      expectedScript: undefined,
      audioPatch,
      scriptPatch: incomingScript
        ? { script: incomingScript, scriptReviewStatus: "用户确认" as const }
        : { scriptReviewStatus: "用户确认" as const }
    });
  });

  server.delete("/api/podcast/episodes/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    let failure: { code: number; error: string } | null = null;
    const persisted = await runStateCommand(
      repository,
      (latest) => {
        failure = null;
        if (!latest.podcastEpisodes.some((ep) => ep.id === id)) {
          failure = { code: 404, error: "Episode not found." };
          return null;
        }
        return deletePodcastEpisode(latest, id);
      },
      { ...writeOpts, label: `command:podcast-delete:${id}` }
    );
    if (!persisted) {
      const f = failure ?? { code: 500, error: "播客未能删除。" };
      return reply.code(f.code).send({ error: f.error });
    }
    return { state: persisted };
  });
}

async function commitSynthesizePatch(
  repository: ProductStateRepository,
  reply: { code: (statusCode: number) => { send: (payload: unknown) => unknown } },
  writeOpts: { writeGate?: WriteGate },
  args: {
    id: string;
    expectedScript?: string;
    audioPatch: Partial<PodcastEpisode>;
    scriptPatch?: Partial<Pick<PodcastEpisode, "script" | "scriptReviewStatus">>;
  }
) {
  let failure: { code: number; error: string } | null = null;
  let updated: PodcastEpisode | undefined;
  const persisted = await runStateCommand(
    repository,
    (latest) => {
      failure = null;
      updated = undefined;
      const current = latest.podcastEpisodes.find((ep) => ep.id === args.id);
      if (!current) {
        failure = { code: 404, error: "Episode not found." };
        return null;
      }
      if (args.expectedScript !== undefined && current.script !== args.expectedScript) {
        failure = { code: 409, error: "稿已改动，请先确认后再合成。" };
        return null;
      }
      const nextEpisode: PodcastEpisode = {
        ...current,
        ...args.scriptPatch,
        ...args.audioPatch,
        status: "ready"
      };
      updated = nextEpisode;
      return replacePodcastEpisode(latest, nextEpisode);
    },
    { ...writeOpts, label: `command:podcast-synthesize:${args.id}` }
  );
  if (!persisted || !updated) {
    const f = failure ?? { code: 500, error: "播客音频未能保存。" };
    return reply.code(f.code).send({ error: f.error });
  }
  if (updated.audioRenderStatus === "failed") {
    return reply.code(502).send({
      error: updated.audioRenderMessage ?? "音频渲染失败。",
      episode: updated,
      state: persisted
    });
  }
  return { episode: updated, state: persisted };
}

function resolveScriptSource(
  state: ProductState,
  sourceType: PodcastEpisode["sourceType"],
  sourceId: string | undefined,
  noteId: string | undefined,
  format: PodcastEpisode["format"]
): { ok: true; scriptSource: PodcastScriptSource } | { ok: false; code: number; error: string } {
  if (sourceType === "search-brief" && sourceId) {
    const brief = state.searchBriefs.find((item) => item.id === sourceId);
    if (!brief) {
      return { ok: false, code: 422, error: "Search brief not found." };
    }
    return { ok: true, scriptSource: { kind: "search-brief", brief, format } };
  }
  if (sourceType === "theme" && sourceId) {
    const theme = state.themes.find((item) => item.id === sourceId);
    if (!theme) {
      return { ok: false, code: 422, error: "Theme not found." };
    }
    return { ok: true, scriptSource: { kind: "theme", theme, format } };
  }
  if (sourceType === "knowledge-debt" && sourceId) {
    const debt = state.debts.find((item) => item.id === sourceId);
    if (!debt) {
      return { ok: false, code: 422, error: "Knowledge debt not found." };
    }
    return { ok: true, scriptSource: { kind: "knowledge-debt", debt, format } };
  }
  if (!noteId) {
    return { ok: false, code: 422, error: "No notes are available for podcast generation." };
  }
  const note = state.notes.find((item) => item.id === noteId);
  if (!note) {
    return { ok: false, code: 422, error: "Note not found." };
  }
  return { ok: true, scriptSource: { kind: "note", note, format } };
}

function buildEpisodeSkeleton(
  state: ProductState,
  scriptSource: PodcastScriptSource,
  voice: string
): PodcastEpisode {
  const format = scriptSource.format;
  if (scriptSource.kind === "search-brief") {
    return generatePodcastEpisodeFromSearchBrief(state, scriptSource.brief.id, { format, voice }).episode;
  }
  if (scriptSource.kind === "theme") {
    return generatePodcastEpisodeFromTheme(state, scriptSource.theme.id, { format, voice }).episode;
  }
  if (scriptSource.kind === "knowledge-debt") {
    return generatePodcastEpisodeFromKnowledgeDebt(state, scriptSource.debt.id, { format, voice }).episode;
  }
  return generatePodcastEpisode(state, scriptSource.note.id, { format, voice }).episode;
}

function withPodcastCreatedEvents(state: ProductState, episode: PodcastEpisode): ProductState {
  const createdAt = episode.createdAt;
  const label =
    episode.sourceType === "knowledge-debt"
      ? "知识债播客脚本已生成"
      : episode.sourceType === "search-brief"
        ? "热点播客脚本已生成"
        : episode.sourceType === "theme"
          ? "主题播客脚本已生成"
          : "播客脚本已生成";
  const sourcePhrase =
    episode.sourceType === "knowledge-debt"
      ? `从知识债《${episode.sourceLabel}》`
      : episode.sourceType === "search-brief"
        ? `从搜索简报《${episode.sourceLabel}》`
        : episode.sourceType === "theme"
          ? `从长期主题《${episode.sourceLabel}》`
          : `从笔记《${episode.sourceLabel}》`;
  return withGeneratedArtifactWorkflowRun(
    withAiRunEvent(
      withAuditEvent(state, {
        type: "podcast_episode_created",
        label,
        detail: `${sourcePhrase}生成待确认脚本《${episode.title}》。`,
        severity: "info",
        entityType: "podcast_episode",
        entityId: episode.id,
        createdAt
      }),
      {
        workflow: "podcast_generation",
        providerId: state.systemConfig.models.synthesisModel,
        status: "succeeded",
        entityType: "podcast_episode",
        entityId: episode.id,
        inputSummary: sourcePhrase,
        outputSummary: `生成待确认播客脚本，预计 ${episode.durationSec} 秒。`,
        estimatedTokens: episode.script.length,
        createdAt
      }
    ),
    {
      workflow: "podcast_generation",
      entityType: "podcast_episode",
      entityId: episode.id,
      inputSummary: sourcePhrase
    }
  );
}

function normalizePayload(value: unknown): PodcastEpisodeRequestPayload {
  if (!value || typeof value === "object") {
    return (value ?? {}) as PodcastEpisodeRequestPayload;
  }
  return {};
}

function normalizeSourceType(value: unknown): PodcastEpisode["sourceType"] {
  if (value === "search-brief" || value === "theme" || value === "knowledge-debt") {
    return value;
  }
  return "note";
}

/** Explicit opt-in only — "auto" must not mean silent spend on create. */
export function shouldAutoRenderPodcastOnCreate(raw: string | undefined): boolean {
  const v = (raw ?? "").trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes" || v === "on";
}

/** Default true. Only explicit false|0|no|off restores the old synthesize-confirms path. */
export function shouldRequirePodcastConfirmOnSynthesize(raw: string | undefined): boolean {
  const v = (raw ?? "").trim().toLowerCase();
  return !(v === "false" || v === "0" || v === "no" || v === "off");
}

function normalizeFormat(value: unknown): PodcastEpisode["format"] {
  return value === "host-guest" ? "host-guest" : "solo";
}

function normalizeProviderVoice(voice: string) {
  return normalizeCosyVoiceId(voice);
}
