// 真实性重构配套改造：note 路径脚本是强制 LLM 能力（无 client→503 / 预算耗尽→429 / 失败→502），
// audioRenderStatus 枚举 "fallback"→"failed"，synthesize 在 TTS 未配置/失败时如实 503/502（脚本不丢）。
// 成功路径注入 createFakeChatClient()（provider 边界的确定性测试替身），走真实 LLM 代码路径。
import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { buildApiServer } from "../server";
import { createInMemoryProductStateRepository } from "../product-state-repository";
import { createInitialProductState } from "../../../../src/domain/engine";
import { createLlmBudget } from "../llm-budget";
import { registerPodcastRoutes } from "./podcast";
import { createFakeChatClient, createFailingChatClient } from "../test-helpers/fake-llm-clients";

describe("POST /api/podcast/episodes", () => {
  it("create defaults to pending script (no auto-TTS); with AUTO_RENDER, TTS failure → failed + script kept", async () => {
    const failingTts = { synthesize: async () => { throw new Error("TTS 400"); } };
    // Default create: no auto render even if TTS client is present (PO-P1-01).
    const serverDefault = buildApiServer({
      env: { DASHSCOPE_API_KEY: "", BAILIAN_API_KEY: "" },
      bailianPodcastAudioClient: failingTts as never,
      bailianChatClient: createFakeChatClient()
    });
    const state0 = (await serverDefault.inject({ method: "GET", url: "/api/state" })).json();
    const noteId = state0.notes[0]?.id;
    const res0 = await serverDefault.inject({
      method: "POST",
      url: "/api/podcast/episodes",
      payload: { noteId, format: "solo", voice: "longyuan_v3" }
    });
    expect(res0.statusCode).toBe(200);
    expect(res0.json().episode.audioRenderStatus).toBe("pending");
    expect(res0.json().episode.script.length).toBeGreaterThan(0);
    await serverDefault.close();

    const prev = process.env.PODCAST_AUTO_RENDER_ON_CREATE;
    process.env.PODCAST_AUTO_RENDER_ON_CREATE = "true";
    try {
      const server = buildApiServer({
      env: { DASHSCOPE_API_KEY: "", BAILIAN_API_KEY: "" },
        bailianPodcastAudioClient: failingTts as never,
        bailianChatClient: createFakeChatClient()
      });
      const state = (await server.inject({ method: "GET", url: "/api/state" })).json();
      const res = await server.inject({
        method: "POST",
        url: "/api/podcast/episodes",
        payload: { noteId: state.notes[0]?.id, format: "solo", voice: "longyuan_v3" }
      });
      expect(res.statusCode).toBe(200);
      const ep = res.json().episode;
      expect(ep.script.length).toBeGreaterThan(0);
      expect(ep.audioRenderStatus).toBe("failed");
      expect(ep.audioRenderMessage).toContain("TTS 400");
      const after = (await server.inject({ method: "GET", url: "/api/state" })).json();
      expect(after.podcastEpisodes.some((e: any) => e.id === ep.id && e.script.length > 0)).toBe(true);
      await server.close();
    } finally {
      if (prev === undefined) delete process.env.PODCAST_AUTO_RENDER_ON_CREATE;
      else process.env.PODCAST_AUTO_RENDER_ON_CREATE = prev;
    }
  });

  it("returns 200 with pending status when no TTS client configured (script LLM still required)", async () => {
    const server = buildApiServer({ bailianChatClient: createFakeChatClient() });
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

  it("persists episode with rendered status when TTS succeeds under AUTO_RENDER", async () => {
    const successTts = {
      synthesize: async () => ({
        audioUrl: "https://example.com/audio.mp3",
        durationSec: 120,
        voice: "longyuan_v3"
      })
    };
    const prev = process.env.PODCAST_AUTO_RENDER_ON_CREATE;
    process.env.PODCAST_AUTO_RENDER_ON_CREATE = "true";
    try {
      const server = buildApiServer({
      env: { DASHSCOPE_API_KEY: "", BAILIAN_API_KEY: "" },
        bailianPodcastAudioClient: successTts as never,
        bailianChatClient: createFakeChatClient()
      });
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
    } finally {
      if (prev === undefined) delete process.env.PODCAST_AUTO_RENDER_ON_CREATE;
      else process.env.PODCAST_AUTO_RENDER_ON_CREATE = prev;
    }
  });

  it("note 路径无 chatClient → 503（脚本 LLM 必选，不落任何 episode）", async () => {
    const server = buildApiServer({ env: { DASHSCOPE_API_KEY: "", BAILIAN_API_KEY: "" } }); // no bailianChatClient
    const state = (await server.inject({ method: "GET", url: "/api/state" })).json();
    const noteId = state.notes[0]?.id;
    const res = await server.inject({
      method: "POST",
      url: "/api/podcast/episodes",
      payload: { noteId, format: "solo", voice: "longyuan_v3" }
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toContain("未配置");
    const after = (await server.inject({ method: "GET", url: "/api/state" })).json();
    expect(after.podcastEpisodes).toHaveLength(state.podcastEpisodes.length); // 原子失败，未落库
    await server.close();
  });

  it("note 路径 LLM 运行时失败 → 502（不落任何 episode）", async () => {
    const server = buildApiServer({
      env: { DASHSCOPE_API_KEY: "", BAILIAN_API_KEY: "" }, bailianChatClient: createFailingChatClient("script boom") });
    const state = (await server.inject({ method: "GET", url: "/api/state" })).json();
    const noteId = state.notes[0]?.id;
    const res = await server.inject({
      method: "POST",
      url: "/api/podcast/episodes",
      payload: { noteId, format: "solo", voice: "longyuan_v3" }
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toContain("播客脚本生成失败");
    const after = (await server.inject({ method: "GET", url: "/api/state" })).json();
    expect(after.podcastEpisodes).toHaveLength(state.podcastEpisodes.length);
    await server.close();
  });

  it("note 路径预算耗尽 → 429", async () => {
    const repository = createInMemoryProductStateRepository(createInitialProductState());
    const exhaustedBudget = createLlmBudget({ maxCallsPerSession: 1 });
    exhaustedBudget.tryConsume("system"); // 消耗唯一配额
    const server = Fastify();
    await registerPodcastRoutes(server, repository, {
      bailianChatClient: createFakeChatClient(),
      llmBudget: exhaustedBudget
    });
    const noteId = repository.getState().notes[0]?.id;
    const res = await server.inject({
      method: "POST",
      url: "/api/podcast/episodes",
      payload: { noteId, format: "solo", voice: "longyuan_v3" }
    });
    expect(res.statusCode).toBe(429);
    expect(res.json().error).toContain("预算已用尽");
    await server.close();
  });
});

describe("POST /api/podcast/episodes/:id/synthesize", () => {
  it("returns 404 when episode does not exist", async () => {
    const server = buildApiServer({
      env: { DASHSCOPE_API_KEY: "", BAILIAN_API_KEY: "" },});
    const res = await server.inject({
      method: "POST",
      url: "/api/podcast/episodes/nonexistent-id/synthesize"
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBeTruthy();
    await server.close();
  });

  it("no TTS client → 503; caller-supplied script is persisted before failing", async () => {
    const server = buildApiServer({
      env: { DASHSCOPE_API_KEY: "", BAILIAN_API_KEY: "" }, bailianChatClient: createFakeChatClient() }); // no TTS
    // First create an episode (creation succeeds with audioRenderStatus=pending)
    const state = (await server.inject({ method: "GET", url: "/api/state" })).json();
    const noteId = state.notes[0]?.id;
    const createRes = await server.inject({
      method: "POST",
      url: "/api/podcast/episodes",
      payload: { noteId, format: "solo", voice: "longyuan_v3" }
    });
    expect(createRes.statusCode).toBe(200);
    const episodeId = createRes.json().episode.id;

    // Now synthesize without a TTS client, carrying an edited script
    const editedScript = "用户编辑后的脚本，正文足够长可用于合成。";
    const res = await server.inject({
      method: "POST",
      url: `/api/podcast/episodes/${episodeId}/synthesize`,
      payload: { script: editedScript }
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toContain("未配置 TTS");
    // 带来的脚本编辑先于失败被持久化（不丢内容）
    const after = (await server.inject({ method: "GET", url: "/api/state" })).json();
    const persisted = after.podcastEpisodes.find((e: any) => e.id === episodeId);
    expect(persisted?.script).toBe(editedScript);
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
    const server = buildApiServer({
      env: { DASHSCOPE_API_KEY: "", BAILIAN_API_KEY: "" },
      bailianPodcastAudioClient: fakeTts as never,
      bailianChatClient: createFakeChatClient()
    });
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

    // Reset capture (create path no longer auto-TTS by default)
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

  it("TTS client throws → 502 {error, episode, state}; script + failed status persisted", async () => {
    const failingTts = { synthesize: async () => { throw new Error("TTS upstream error"); } };
    const server = buildApiServer({
      env: { DASHSCOPE_API_KEY: "", BAILIAN_API_KEY: "" },
      bailianPodcastAudioClient: failingTts as never,
      bailianChatClient: createFakeChatClient()
    });
    const state = (await server.inject({ method: "GET", url: "/api/state" })).json();
    const noteId = state.notes[0]?.id;
    // Create episode (default: pending script; TTS failure is exercised on synthesize)
    const createRes = await server.inject({
      method: "POST",
      url: "/api/podcast/episodes",
      payload: { noteId, format: "solo", voice: "longyuan_v3" }
    });
    expect(createRes.statusCode).toBe(200);
    expect(createRes.json().episode.audioRenderStatus).toBe("pending");
    const episodeId = createRes.json().episode.id;

    const res = await server.inject({
      method: "POST",
      url: `/api/podcast/episodes/${episodeId}/synthesize`
    });
    expect(res.statusCode).toBe(502);
    const body = res.json();
    expect(body.error).toContain("音频渲染失败");
    expect(body.episode.audioRenderStatus).toBe("failed");
    expect(body.state).toBeDefined();
    // 失败状态与脚本已持久化（不丢内容），供客户端同步 revision 后重试
    const after = (await server.inject({ method: "GET", url: "/api/state" })).json();
    const persisted = after.podcastEpisodes.find((e: any) => e.id === episodeId);
    expect(persisted?.audioRenderStatus).toBe("failed");
    expect(persisted?.script.length).toBeGreaterThan(0);
    await server.close();
  });
});


describe("POST /api/podcast/episodes multi-source LLM", () => {
  it("theme path uses LLM script (not domain template body)", async () => {
    const llmBody = "主题路径 LLM 脚本正文：控制感与授权边界。";
    const server = buildApiServer({
      bailianChatClient: createFakeChatClient({ podcastScript: llmBody })
    });
    const state = (await server.inject({ method: "GET", url: "/api/state" })).json();
    const themeId = state.themes[0]?.id;
    expect(themeId).toBeTruthy();
    const res = await server.inject({
      method: "POST",
      url: "/api/podcast/episodes",
      payload: { sourceType: "theme", sourceId: themeId, format: "solo", voice: "longyuan_v3" }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().episode.script).toBe(llmBody);
    expect(res.json().episode.audioRenderStatus).toBe("pending");
    await server.close();
  });

  it("knowledge-debt path uses LLM script", async () => {
    const llmBody = "知识债路径 LLM 脚本正文：组织惯性。";
    const server = buildApiServer({
      bailianChatClient: createFakeChatClient({ podcastScript: llmBody })
    });
    const state = (await server.inject({ method: "GET", url: "/api/state" })).json();
    const debtId = state.debts[0]?.id;
    expect(debtId).toBeTruthy();
    const res = await server.inject({
      method: "POST",
      url: "/api/podcast/episodes",
      payload: { sourceType: "knowledge-debt", sourceId: debtId, format: "host-guest", voice: "longyuan_v3" }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().episode.script).toBe(llmBody);
    await server.close();
  });

  it("search-brief path uses LLM script when brief exists", async () => {
    const llmBody = "简报路径 LLM 脚本正文。";
    const base = createInitialProductState();
    const brief = {
      id: "brief-podcast-1",
      topic: "AI 产品定价",
      provider: "local-demo" as const,
      status: "ready" as const,
      summary: "市场对订阅与用量计费仍有分歧。",
      facts: ["并行提供席位与 token 计费"],
      controversies: ["免费额度是否扭曲需求"],
      opposingViews: ["应按结果收费"],
      interviewAngles: ["你上次为何改定价？"],
      discussionTopics: ["定价对销售话术的影响"],
      sourceAngles: [],
      sources: [
        {
          id: "src-1",
          title: "定价观察",
          url: "https://example.com/pricing",
          publisher: "示例刊",
          publishedAt: "2026-06-01T00:00:00.000Z",
          snippet: "snippet",
          relevanceScore: 0.9,
          usage: "interview-context" as const
        }
      ],
      sourceTrace: [],
      appliedToSessionIds: [],
      createdAt: "2026-06-01T00:00:00.000Z"
    };
    const repository = createInMemoryProductStateRepository({
      ...base,
      searchBriefs: [brief]
    });
    const server = Fastify();
    await registerPodcastRoutes(server, repository, {
      bailianChatClient: createFakeChatClient({ podcastScript: llmBody })
    });
    const res = await server.inject({
      method: "POST",
      url: "/api/podcast/episodes",
      payload: { sourceType: "search-brief", sourceId: brief.id, format: "solo", voice: "longyuan_v3" }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().episode.script).toBe(llmBody);
    await server.close();
  });

  it("non-note path without chatClient → 503", async () => {
    const server = buildApiServer({ env: { DASHSCOPE_API_KEY: "", BAILIAN_API_KEY: "" } });
    const state = (await server.inject({ method: "GET", url: "/api/state" })).json();
    const themeId = state.themes[0]?.id;
    const res = await server.inject({
      method: "POST",
      url: "/api/podcast/episodes",
      payload: { sourceType: "theme", sourceId: themeId, format: "solo" }
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toContain("未配置");
    await server.close();
  });
});

describe("DELETE /api/podcast/episodes/:id", () => {
  it("removes episode from authoritative state", async () => {
    const server = buildApiServer({ bailianChatClient: createFakeChatClient() });
    const state = (await server.inject({ method: "GET", url: "/api/state" })).json();
    const noteId = state.notes[0]?.id;
    const createRes = await server.inject({
      method: "POST",
      url: "/api/podcast/episodes",
      payload: { noteId, format: "solo", voice: "longyuan_v3" }
    });
    expect(createRes.statusCode).toBe(200);
    const episodeId = createRes.json().episode.id;
    const del = await server.inject({ method: "DELETE", url: `/api/podcast/episodes/${episodeId}` });
    expect(del.statusCode).toBe(200);
    const after = del.json().state;
    expect(after.podcastEpisodes.some((e: { id: string }) => e.id === episodeId)).toBe(false);
    const missing = await server.inject({ method: "DELETE", url: "/api/podcast/episodes/nope" });
    expect(missing.statusCode).toBe(404);
    await server.close();
  });
});
