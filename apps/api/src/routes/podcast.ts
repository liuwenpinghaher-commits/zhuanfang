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
      ({ episode, nextState } = generatePodcastEpisode(state, noteId, { format, voice }));

      // For the note path, if a chat client is available, attempt LLM script generation.
      // This happens BEFORE persist so the saved script is the LLM-generated one.
      const allowLlm = !!options.bailianChatClient && budget.tryConsume("system");
      if (!!options.bailianChatClient && !allowLlm) {
        console.warn(JSON.stringify({ event: "llm_budget_exceeded", capability: "podcast_script" }));
      }
      if (allowLlm) {
        const note = state.notes.find((n) => n.id === noteId) ?? state.notes[0];
        if (note) {
          try {
            const llmScript = await generatePodcastScript(
              { note, format },
              options.bailianChatClient!
            );
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
          } catch (llmError) {
            console.warn(
              JSON.stringify({
                event: "llm_fallback",
                capability: "podcast_script",
                error: llmError instanceof Error ? llmError.message : String(llmError)
              })
            );
            // Keep the deterministic script already in episode
          }
        }
      }
    }

    // --- Step 1: Persist the episode FIRST (script is now saved, TTS failure won't lose it) ---
    repository.replaceState(nextState);

    // --- Step 2: If no TTS client, return the persisted episode as-is ---
    if (!options.bailianPodcastAudioClient) {
      return { episode, state: nextState };
    }

    // --- Step 3: Attempt TTS; degrade gracefully on failure ---
    let finalEpisode = episode;
    let finalState = nextState;

    try {
      const renderedAudio = await options.bailianPodcastAudioClient.synthesize({
        text: episode.script,
        voice: normalizeProviderVoice(voice)
      });
      finalEpisode = {
        ...episode,
        audioUrl: renderedAudio.audioUrl,
        durationSec: renderedAudio.durationSec ?? episode.durationSec,
        voice: renderedAudio.voice,
        audioRenderStatus: "rendered",
        audioRenderMessage: "音频已渲染。"
      };
    } catch (ttsError) {
      finalEpisode = {
        ...episode,
        audioRenderStatus: "fallback",
        audioRenderMessage: "音频渲染失败，脚本已保留，可稍后重试。"
      };
      console.warn(
        JSON.stringify({
          event: "llm_fallback",
          capability: "podcast_tts",
          error: ttsError instanceof Error ? ttsError.message : String(ttsError)
        })
      );
    }

    finalState = {
      ...nextState,
      podcastEpisodes: nextState.podcastEpisodes.map((item) =>
        item.id === episode.id ? finalEpisode : item
      )
    };
    repository.replaceState(finalState);
    return { episode: finalEpisode, state: finalState };
  });
}

function normalizePayload(value: unknown): PodcastEpisodeRequestPayload {
  if (!value || typeof value !== "object") {
    return {};
  }
  return value as PodcastEpisodeRequestPayload;
}

function normalizeSourceType(value: unknown): PodcastEpisode["sourceType"] {
  if (value === "search-brief" || value === "theme" || value === "knowledge-debt" || value === "corpus-insight") {
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
