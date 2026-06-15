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
