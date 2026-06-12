import type { FastifyInstance } from "fastify";
import { generatePodcastEpisode } from "../../../../src/domain/engine";
import type { PodcastEpisode } from "../../../../src/domain/types";
import type { BailianPodcastAudioClient } from "../providers/bailian";
import type { ProductStateRepository } from "../product-state-repository";

interface PodcastEpisodeRequestPayload {
  noteId?: unknown;
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
    if (state.notes.length === 0) {
      return reply.code(422).send({ error: "No notes are available for podcast generation." });
    }

    const payload = normalizePayload(request.body);
    const noteId = typeof payload.noteId === "string" && payload.noteId ? payload.noteId : state.notes[0].id;
    const format = normalizeFormat(payload.format);
    const voice =
      typeof payload.voice === "string" && payload.voice.trim()
        ? payload.voice.trim()
        : state.systemConfig.voice.podcastVoice;
    const { episode, nextState } = generatePodcastEpisode(state, noteId, { format, voice });

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

function normalizeFormat(value: unknown): PodcastEpisode["format"] {
  return value === "host-guest" ? "host-guest" : "solo";
}

function normalizeProviderVoice(voice: string) {
  return voice === "calm-host" || voice === "warm-interviewer" ? undefined : voice;
}
