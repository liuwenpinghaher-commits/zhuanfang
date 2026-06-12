import type { FastifyInstance } from "fastify";
import {
  generatePodcastEpisode,
  generatePodcastEpisodeFromKnowledgeDebt,
  generatePodcastEpisodeFromSearchBrief,
  generatePodcastEpisodeFromTheme
} from "../../../../src/domain/engine";
import type { PodcastEpisode } from "../../../../src/domain/types";
import type { BailianPodcastAudioClient } from "../providers/bailian";
import type { ProductStateRepository } from "../product-state-repository";

interface PodcastEpisodeRequestPayload {
  noteId?: unknown;
  sourceType?: unknown;
  sourceId?: unknown;
  format?: unknown;
  voice?: unknown;
}

interface PodcastRouteOptions {
  bailianPodcastAudioClient?: BailianPodcastAudioClient;
}

export async function registerPodcastRoutes(
  server: FastifyInstance,
  repository: ProductStateRepository,
  options: PodcastRouteOptions = {}
) {
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
    }

    if (!options.bailianPodcastAudioClient) {
      repository.replaceState(nextState);
      return { episode, state: nextState };
    }

    const renderedAudio = await options.bailianPodcastAudioClient.synthesize({
      text: episode.script,
      voice: normalizeProviderVoice(voice)
    });
    const episodeWithAudio: PodcastEpisode = {
      ...episode,
      audioUrl: renderedAudio.audioUrl,
      durationSec: renderedAudio.durationSec ?? episode.durationSec,
      voice: renderedAudio.voice
    };
    const nextStateWithAudio = {
      ...nextState,
      podcastEpisodes: nextState.podcastEpisodes.map((item) => (item.id === episode.id ? episodeWithAudio : item))
    };

    repository.replaceState(nextStateWithAudio);
    return { episode: episodeWithAudio, state: nextStateWithAudio };
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
