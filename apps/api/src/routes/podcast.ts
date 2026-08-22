import type { FastifyInstance } from "fastify";
import {
  confirmPodcastScript,
  generatePodcastEpisode,
  generatePodcastEpisodeFromKnowledgeDebt,
  generatePodcastEpisodeFromSearchBrief,
  generatePodcastEpisodeFromTheme,
  parsePodcastDialogue,
  prependPodcastEpisode,
  replacePodcastEpisode,
  resolveEpisodeVoices,
  scalePodcastChapters,
  withGeneratedArtifactWorkflowRun
} from "../../../../src/domain/engine";
import { clampPodcastGuestVoice } from "../../../../src/domain/podcast-voices";
import { deletePodcastEpisode } from "../../../../src/domain/lifecycle";
import type { PodcastEpisode, ProductState } from "../../../../src/domain/types";
import { makeId, withAiRunEvent, withAuditEvent } from "../../../../src/domain/utils";
import { createLlmBudget, type LlmBudget } from "../llm-budget";
import type { BailianChatClient, BailianPodcastAudioClient } from "../providers/bailian";
import type { ProductStateRepository } from "../product-state-repository";
import { generatePodcastScriptFromSource } from "../intelligence/podcast-script-llm";
import { normalizeCosyVoiceId, resolveQwenAudioTtsVoice } from "../voice-presets";
import { pcmToWav, QWEN_AUDIO_TTS_SAMPLE_RATE, wavToPcm } from "../providers/bailian-tts-inference";
import { runStateCommand } from "../state-command";
import type { WriteGate } from "../server";
import { readPodcastAudio, writePodcastAudio } from "../podcast-audio-store";

const PODCAST_SCRIPT_MAX_CHARS = 32_000;

interface PodcastEpisodeRequestPayload {
  noteId?: unknown;
  sourceType?: unknown;
  sourceId?: unknown;
  format?: unknown;
  voice?: unknown;
  guestVoice?: unknown;
}

const UNDUAL_MESSAGE = "这篇对谈稿没有把主持人和来宾分开写。先改稿再合成。";

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
    const wantDual = episode.format === "host-guest";
    const dialogue = parsePodcastDialogue(episode.script);
    const parsedDual =
      dialogue.some((item) => item.role === "host") &&
      dialogue.some((item) => item.role === "guest");
    if (wantDual && !parsedDual && !shouldFallbackUnlabeledHostGuest(process.env.PODCAST_HOST_GUEST_UNLABELED_FALLBACK)) {
      console.warn(JSON.stringify({ event: "podcast_tts_rejected_undual", episodeId: episode.id }));
      return {
        audioRenderStatus: "failed",
        audioRenderMessage: UNDUAL_MESSAGE
      };
    }
    const dual = wantDual && parsedDual;
    const resolved = resolveEpisodeVoices(episode);
    const hostVoice = resolveQwenAudioTtsVoice(resolved.host);
    const guestVoice = resolveQwenAudioTtsVoice(resolved.guest);
    const turns = dual ? dialogue : [{ role: "host" as const, text: episode.script }];

    const sampleRate = QWEN_AUDIO_TTS_SAMPLE_RATE;
    const silence = Buffer.alloc(Math.round(sampleRate * 0.28 * 2));
    const pcmParts: Buffer[] = [];
    let lastRemoteUrl: string | undefined;
    let lastExpiresAt: number | undefined;
    for (let index = 0; index < turns.length; index += 1) {
      const turn = turns[index]!;
      const renderedAudio = await audioClient.synthesize({
        text: turn.text,
        voice: turn.role === "guest" ? guestVoice : hostVoice
      });
      if (renderedAudio.audioBytes && renderedAudio.audioBytes.byteLength > 0) {
        pcmParts.push(wavToPcm(Buffer.from(renderedAudio.audioBytes)));
      } else if (dual) {
        throw new Error("主持对谈需要两个人声，当前合成没有返回逐句声音。");
      } else if (renderedAudio.audioUrl) {
        lastRemoteUrl = renderedAudio.audioUrl;
      }
      if (typeof renderedAudio.expiresAt === "number") lastExpiresAt = renderedAudio.expiresAt;
      if (dual && index < turns.length - 1) pcmParts.push(silence);
    }

    let audioUrl = lastRemoteUrl ?? `local-audio://${episode.id}.wav`;
    let durationSec = episode.durationSec;
    if (pcmParts.length > 0) {
      const pcm = Buffer.concat(pcmParts);
      const wav = pcmToWav(pcm, sampleRate);
      audioUrl = await writePodcastAudio(episode.id, wav);
      durationSec = Math.max(1, Math.round(pcm.length / 2 / sampleRate));
    } else if (!lastRemoteUrl) {
      throw new Error("TTS returned no audio.");
    }

    if (dual) {
      console.warn(
        JSON.stringify({
          event: "podcast_tts_dual",
          episodeId: episode.id,
          turns: turns.length,
          host: resolved.host,
          guest: resolved.guest,
          guestFromFallback: resolved.guestFromFallback
        })
      );
    }

    return {
      audioUrl,
      durationSec,
      audioRenderStatus: "rendered",
      audioRenderMessage: dual ? "音频已渲染（主持 / 来宾双声）。" : "音频已渲染。",
      chapters: scalePodcastChapters(episode.chapters, episode.durationSec, durationSec),
      ...(typeof lastExpiresAt === "number"
        ? { audioExpiresAt: new Date(lastExpiresAt * 1000).toISOString() }
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
    const guestVoice = clampPodcastGuestVoice(payload.guestVoice);

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

    const skeleton = buildEpisodeSkeleton(repository.getState(), scriptSource, voice, guestVoice);
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

  server.get("/api/podcast/episodes/:id/audio", async (request, reply) => {
    const { id } = request.params as { id: string };
    const episode = repository.getState().podcastEpisodes.find((item) => item.id === id);
    if (!episode) {
      return reply.code(404).send({ error: "Episode not found." });
    }
    const bytes = await readPodcastAudio(id);
    if (!bytes) {
      return reply.code(404).send({ error: "Audio not found." });
    }
    return reply
      .header("content-type", "audio/wav")
      .header("content-length", String(bytes.length))
      .header("x-content-type-options", "nosniff")
      .header("cache-control", "private, max-age=3600")
      .send(bytes);
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
      const wantDual = current.format === "host-guest";
      const dialogue = parsePodcastDialogue(current.script);
      const parsedDual =
        dialogue.some((item) => item.role === "host") &&
        dialogue.some((item) => item.role === "guest");
      if (
        wantDual &&
        !parsedDual &&
        !shouldFallbackUnlabeledHostGuest(process.env.PODCAST_HOST_GUEST_UNLABELED_FALLBACK)
      ) {
        console.warn(JSON.stringify({ event: "podcast_tts_rejected_undual", episodeId: id }));
        return reply.code(409).send({ error: UNDUAL_MESSAGE });
      }
      const voicePatch = voicePatchFromBody(body);
      const episodeToRender: PodcastEpisode = applyVoicePatch(current, voicePatch);
      if (!options.bailianPodcastAudioClient) {
        return reply.code(503).send({ error: "未配置 TTS 服务（缺少 DASHSCOPE_API_KEY），无法合成音频。脚本已保留。" });
      }

      const audioPatch = await renderEpisodeAudio(episodeToRender, options.bailianPodcastAudioClient);
      return commitSynthesizePatch(repository, reply, writeOpts, {
        id,
        expectedScript: episodeToRender.script,
        audioPatch,
        voicePatch
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

    const voicePatch = voicePatchFromBody(body);
    const audioPatch = await renderEpisodeAudio(applyVoicePatch(episodeToRender, voicePatch), options.bailianPodcastAudioClient);
    return commitSynthesizePatch(repository, reply, writeOpts, {
      id,
      expectedScript: undefined,
      audioPatch,
      voicePatch,
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
    voicePatch?: Partial<Pick<PodcastEpisode, "voice" | "guestVoice">> & { clearGuestVoice?: boolean };
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
      const merged: PodcastEpisode = {
        ...current,
        ...args.scriptPatch,
        ...(args.voicePatch?.voice ? { voice: args.voicePatch.voice } : {}),
        ...args.audioPatch,
        status: "ready"
      };
      const nextEpisode: PodcastEpisode = args.voicePatch?.clearGuestVoice
        ? omitGuestVoice(merged)
        : args.voicePatch?.guestVoice
          ? { ...merged, guestVoice: args.voicePatch.guestVoice }
          : merged;
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
  voice: string,
  guestVoice?: string
): PodcastEpisode {
  const format = scriptSource.format;
  const options = { format, voice, guestVoice };
  if (scriptSource.kind === "search-brief") {
    return generatePodcastEpisodeFromSearchBrief(state, scriptSource.brief.id, options).episode;
  }
  if (scriptSource.kind === "theme") {
    return generatePodcastEpisodeFromTheme(state, scriptSource.theme.id, options).episode;
  }
  if (scriptSource.kind === "knowledge-debt") {
    return generatePodcastEpisodeFromKnowledgeDebt(state, scriptSource.debt.id, options).episode;
  }
  return generatePodcastEpisode(state, scriptSource.note.id, options).episode;
}

function voicePatchFromBody(body: Record<string, unknown>): {
  voice?: string;
  guestVoice?: string;
  clearGuestVoice?: boolean;
} {
  const patch: { voice?: string; guestVoice?: string; clearGuestVoice?: boolean } = {};
  if (typeof body.voice === "string" && body.voice.trim()) {
    patch.voice = body.voice.trim();
  }
  if ("guestVoice" in body) {
    const guest = clampPodcastGuestVoice(body.guestVoice);
    if (guest) patch.guestVoice = guest;
    else patch.clearGuestVoice = true;
  }
  return patch;
}

function applyVoicePatch(
  episode: PodcastEpisode,
  patch: { voice?: string; guestVoice?: string; clearGuestVoice?: boolean }
): PodcastEpisode {
  const next: PodcastEpisode = {
    ...episode,
    ...(patch.voice ? { voice: patch.voice } : {}),
    ...(patch.guestVoice ? { guestVoice: patch.guestVoice } : {})
  };
  return patch.clearGuestVoice ? omitGuestVoice(next) : next;
}

function omitGuestVoice(episode: PodcastEpisode): PodcastEpisode {
  const { guestVoice: _omit, ...rest } = episode;
  return rest;
}

export function shouldFallbackUnlabeledHostGuest(raw: string | undefined): boolean {
  const v = (raw ?? "").trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes" || v === "on";
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
