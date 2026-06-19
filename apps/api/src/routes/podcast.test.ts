import { describe, expect, it } from "vitest";
import { buildApiServer } from "../server";

describe("POST /api/podcast/episodes", () => {
  it("persists the episode + script even when TTS fails (no 500, no data loss)", async () => {
    const failingTts = { synthesize: async () => { throw new Error("TTS 400"); } };
    const server = buildApiServer({ bailianPodcastAudioClient: failingTts as never });
    const state = (await server.inject({ method: "GET", url: "/api/state" })).json();
    const noteId = state.notes[0]?.id; // demo default has a seed note
    const res = await server.inject({
      method: "POST",
      url: "/api/podcast/episodes",
      payload: { noteId, format: "solo", voice: "longyuan_v3" }
    });
    expect(res.statusCode).toBe(200);
    const ep = res.json().episode;
    expect(ep.script.length).toBeGreaterThan(0);
    // assert the audio lifecycle field reflects failure — "fallback" is the union value for TTS failure
    expect(ep.audioRenderStatus).toBe("fallback");
    // and the episode is actually persisted in state:
    const after = (await server.inject({ method: "GET", url: "/api/state" })).json();
    expect(after.podcastEpisodes.some((e: any) => e.id === ep.id && e.script.length > 0)).toBe(true);
    await server.close();
  });

  it("returns 200 with pending status when no TTS client configured", async () => {
    const server = buildApiServer({});
    const state = (await server.inject({ method: "GET", url: "/api/state" })).json();
    const noteId = state.notes[0]?.id;
    const res = await server.inject({
      method: "POST",
      url: "/api/podcast/episodes",
      payload: { noteId, format: "solo", voice: "longyuan_v3" }
    });
    expect(res.statusCode).toBe(200);
    const ep = res.json().episode;
    expect(ep.script.length).toBeGreaterThan(0);
    expect(ep.audioRenderStatus).toBe("pending");
    await server.close();
  });

  it("persists episode with rendered status when TTS succeeds", async () => {
    const successTts = {
      synthesize: async () => ({
        audioUrl: "https://example.com/audio.mp3",
        durationSec: 120,
        voice: "longyuan_v3"
      })
    };
    const server = buildApiServer({ bailianPodcastAudioClient: successTts as never });
    const state = (await server.inject({ method: "GET", url: "/api/state" })).json();
    const noteId = state.notes[0]?.id;
    const res = await server.inject({
      method: "POST",
      url: "/api/podcast/episodes",
      payload: { noteId, format: "solo", voice: "longyuan_v3" }
    });
    expect(res.statusCode).toBe(200);
    const ep = res.json().episode;
    expect(ep.audioRenderStatus).toBe("rendered");
    expect(ep.audioUrl).toBe("https://example.com/audio.mp3");
    await server.close();
  });
});

describe("POST /api/podcast/episodes/:id/synthesize", () => {
  it("returns 404 when episode does not exist", async () => {
    const server = buildApiServer({});
    const res = await server.inject({
      method: "POST",
      url: "/api/podcast/episodes/nonexistent-id/synthesize"
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBeTruthy();
    await server.close();
  });

  it("degrades to fallback when no TTS client configured", async () => {
    const server = buildApiServer({});
    // First create an episode
    const state = (await server.inject({ method: "GET", url: "/api/state" })).json();
    const noteId = state.notes[0]?.id;
    const createRes = await server.inject({
      method: "POST",
      url: "/api/podcast/episodes",
      payload: { noteId, format: "solo", voice: "longyuan_v3" }
    });
    const episodeId = createRes.json().episode.id;

    // Now synthesize without a TTS client
    const res = await server.inject({
      method: "POST",
      url: `/api/podcast/episodes/${episodeId}/synthesize`
    });
    expect(res.statusCode).toBe(200);
    const ep = res.json().episode;
    expect(ep.audioRenderStatus).toBe("fallback");
    expect(ep.status).toBe("ready");
    expect(ep.scriptReviewStatus).toBe("用户确认");
    await server.close();
  });

  it("uses episode.script for TTS rendering (fake client validates script is passed)", async () => {
    let capturedText: string | undefined;
    const fakeTts = {
      synthesize: async (input: { text: string; voice?: string }) => {
        capturedText = input.text;
        return { audioUrl: "https://example.com/synth.mp3", durationSec: 180, voice: "longyuan_v3" };
      }
    };
    const server = buildApiServer({ bailianPodcastAudioClient: fakeTts as never });
    // Create an episode first
    const state = (await server.inject({ method: "GET", url: "/api/state" })).json();
    const noteId = state.notes[0]?.id;
    const createRes = await server.inject({
      method: "POST",
      url: "/api/podcast/episodes",
      payload: { noteId, format: "solo", voice: "longyuan_v3" }
    });
    const created = createRes.json().episode;
    const episodeId = created.id;

    // Reset capture (TTS was called during creation too)
    capturedText = undefined;

    const res = await server.inject({
      method: "POST",
      url: `/api/podcast/episodes/${episodeId}/synthesize`
    });
    expect(res.statusCode).toBe(200);
    const ep = res.json().episode;
    expect(ep.audioRenderStatus).toBe("rendered");
    expect(ep.audioUrl).toBe("https://example.com/synth.mp3");
    expect(ep.status).toBe("ready");
    // Verify TTS was called with the episode's actual script
    expect(capturedText).toBe(created.script);

    // Verify state is persisted
    const after = (await server.inject({ method: "GET", url: "/api/state" })).json();
    const persisted = after.podcastEpisodes.find((e: any) => e.id === episodeId);
    expect(persisted?.audioRenderStatus).toBe("rendered");
    await server.close();
  });

  it("degrades to fallback when TTS client throws", async () => {
    const failingTts = { synthesize: async () => { throw new Error("TTS upstream error"); } };
    const server = buildApiServer({ bailianPodcastAudioClient: failingTts as never });
    const state = (await server.inject({ method: "GET", url: "/api/state" })).json();
    const noteId = state.notes[0]?.id;
    // Create episode (will also fail TTS, starting as fallback)
    const createRes = await server.inject({
      method: "POST",
      url: "/api/podcast/episodes",
      payload: { noteId, format: "solo", voice: "longyuan_v3" }
    });
    const episodeId = createRes.json().episode.id;

    const res = await server.inject({
      method: "POST",
      url: `/api/podcast/episodes/${episodeId}/synthesize`
    });
    expect(res.statusCode).toBe(200);
    const ep = res.json().episode;
    expect(ep.audioRenderStatus).toBe("fallback");
    expect(ep.status).toBe("ready");
    await server.close();
  });
});
