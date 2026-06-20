import { describe, expect, it, vi } from "vitest";
import { createInitialProductState, createSessionDraft } from "../domain/engine";
import { createProductApiClient } from "./productApi";

describe("product api client", () => {
  it("loads and normalizes product state from the API", async () => {
    const state = createInitialProductState();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(state), { status: 200 }));
    const client = createProductApiClient("http://127.0.0.1:8787", fetchImpl);

    const result = await client.getState();

    expect(fetchImpl).toHaveBeenCalledWith("http://127.0.0.1:8787/api/state", { method: "GET" });
    expect(result.profile.name).toBe("Mia");
    expect(result.systemConfig.search.activeProvider).toBe("bailian");
  });

  it("resets state through the API", async () => {
    const state = createInitialProductState();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(state), { status: 200 }));
    const client = createProductApiClient("http://127.0.0.1:8787", fetchImpl);

    const result = await client.resetState();

    expect(fetchImpl).toHaveBeenCalledWith("http://127.0.0.1:8787/api/state/reset", { method: "POST" });
    expect(result.profile.name).toBe("Mia");
  });

  it("saves state through the API", async () => {
    const state = createInitialProductState();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(state), { status: 200 }));
    const client = createProductApiClient("http://127.0.0.1:8787", fetchImpl);

    const result = await client.saveState(state);

    expect(fetchImpl).toHaveBeenCalledWith("http://127.0.0.1:8787/api/state", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(state)
    });
    expect(result.conflicted).toBe(false);
    expect(result.state.profile.name).toBe("Mia");
  });

  it("loads system capability health from the Product API", async () => {
    const response = {
      generatedAt: "2026-06-10T00:00:00.000Z",
      configVersion: "base-v1",
      runtime: {
        service: "interview-product-api",
        stateStore: "memory"
      },
      capabilities: [
        {
          id: "anysearch",
          kind: "search",
          label: "AnySearch",
          status: "needs-key",
          active: false,
          detail: "ANYSEARCH_API_KEY 未配置。",
          requiredEnv: ["ANYSEARCH_API_KEY"],
          lastCheckedAt: "2026-06-10T00:00:00.000Z"
        }
      ]
    };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(response), { status: 200 }));
    const client = createProductApiClient("http://127.0.0.1:8787", fetchImpl);

    const result = await client.getSystemCapabilities();

    expect(fetchImpl).toHaveBeenCalledWith("http://127.0.0.1:8787/api/system/capabilities", { method: "GET" });
    expect(result.capabilities[0]).toMatchObject({
      id: "anysearch",
      status: "needs-key",
      requiredEnv: ["ANYSEARCH_API_KEY"]
    });
  });

  it("loads editable system configuration from the Product API", async () => {
    const response = {
      generatedAt: "2026-06-10T00:00:00.000Z",
      envFilePath: "/tmp/.env.local",
      sections: [
        {
          id: "secrets",
          label: "密钥",
          settings: [
            {
              key: "DASHSCOPE_API_KEY",
              label: "DashScope / 百炼 API Key",
              description: "百炼主密钥。",
              valueKind: "secret",
              secret: true,
              configured: true,
              value: null,
              maskedValue: "已配置（末 4 位 1234）"
            }
          ]
        }
      ]
    };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(response), { status: 200 }));
    const client = createProductApiClient("http://127.0.0.1:8787", fetchImpl);

    const result = await client.getSystemConfig();

    expect(fetchImpl).toHaveBeenCalledWith("http://127.0.0.1:8787/api/system/config", { method: "GET" });
    expect(result.sections[0].settings[0]).toMatchObject({
      key: "DASHSCOPE_API_KEY",
      secret: true,
      value: null,
      maskedValue: "已配置（末 4 位 1234）"
    });
  });

  it("updates editable system configuration through the Product API", async () => {
    const response = {
      settingsUpdated: ["DASHSCOPE_API_KEY", "BAILIAN_SEARCH_MODEL"],
      config: {
        generatedAt: "2026-06-10T00:00:00.000Z",
        envFilePath: "/tmp/.env.local",
        sections: []
      }
    };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(response), { status: 200 }));
    const client = createProductApiClient("http://127.0.0.1:8787", fetchImpl);

    const result = await client.updateSystemConfig({
      DASHSCOPE_API_KEY: "secret-dashscope-key",
      BAILIAN_SEARCH_MODEL: "qwen3.7-plus"
    });

    expect(fetchImpl).toHaveBeenCalledWith("http://127.0.0.1:8787/api/system/config", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        updates: {
          DASHSCOPE_API_KEY: "secret-dashscope-key",
          BAILIAN_SEARCH_MODEL: "qwen3.7-plus"
        }
      })
    });
    expect(result.settingsUpdated).toEqual(["DASHSCOPE_API_KEY", "BAILIAN_SEARCH_MODEL"]);
  });

  it("creates search briefs through the API", async () => {
    const state = createInitialProductState();
    const response = {
      brief: {
        id: "brief-api",
        topic: "AI 产品商业化热点",
        provider: "anysearch",
        status: "needs-review",
        summary: "摘要",
        discussionTopics: [],
        sourceAngles: [],
        sources: [],
        createdAt: "2026-06-10T00:00:00.000Z"
      },
      state,
      task: {
        label: "联网搜索",
        status: "degraded",
        canRetry: true,
        providerId: "anysearch",
        result: undefined,
        degradedReason: "AnySearch API key 未配置"
      }
    };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(response), { status: 200 }));
    const client = createProductApiClient("http://127.0.0.1:8787/", fetchImpl);

    const result = await client.createSearchBrief({
      topic: "AI 产品商业化热点",
      providerId: "anysearch",
      maxSources: 3,
      recencyDays: 14
    });

    expect(fetchImpl).toHaveBeenCalledWith("http://127.0.0.1:8787/api/search/briefs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        topic: "AI 产品商业化热点",
        providerId: "anysearch",
        maxSources: 3,
        recencyDays: 14
      })
    });
    expect(result.brief.topic).toBe("AI 产品商业化热点");
    expect(result.task.status).toBe("degraded");
    expect(result.state.profile.name).toBe("Mia");
  });

  it("generates podcast episodes through the API", async () => {
    const state = createInitialProductState();
    const episode = {
      id: "podcast-api",
      noteId: state.notes[0].id,
      title: "播客：测试",
      format: "solo",
      voice: "calm-host",
      status: "ready",
      durationSec: 180,
      script: "脚本",
      chapters: [],
      audioUrl: "local-audio://test.mp3",
      shownotes: [],
      createdAt: "2026-06-10T00:00:00.000Z"
    };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ episode, state }), { status: 200 }));
    const client = createProductApiClient("http://127.0.0.1:8787", fetchImpl);

    const result = await client.generatePodcastEpisode({
      noteId: state.notes[0].id,
      format: "solo",
      voice: "calm-host"
    });

    expect(fetchImpl).toHaveBeenCalledWith("http://127.0.0.1:8787/api/podcast/episodes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        noteId: state.notes[0].id,
        format: "solo",
        voice: "calm-host"
      })
    });
    expect(result.episode.voice).toBe("calm-host");
    expect(result.state.profile.name).toBe("Mia");
  });

  it("analyzes corpus imports through the API", async () => {
    const state = createInitialProductState();
    const insight = {
      id: "insight-api",
      importId: "corpus-api",
      title: "优秀专访样本：访谈逻辑分析",
      dimensions: [],
      recommendedPatches: [],
      createdAt: "2026-06-10T00:00:00.000Z"
    };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ insight, state }), { status: 200 }));
    const client = createProductApiClient("http://127.0.0.1:8787", fetchImpl);

    const result = await client.analyzeCorpusImport({
      title: "优秀专访样本",
      mediaType: "text",
      content: "主持人：讲一个具体时刻。"
    });

    expect(fetchImpl).toHaveBeenCalledWith("http://127.0.0.1:8787/api/corpus/insights", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "优秀专访样本",
        mediaType: "text",
        content: "主持人：讲一个具体时刻。"
      })
    });
    expect(result.insight.title).toBe("优秀专访样本：访谈逻辑分析");
    expect(result.state.profile.name).toBe("Mia");
  });

  it("transcribes audio corpus sources through the API", async () => {
    const transcription = {
      providerId: "local-fallback",
      model: "manual-transcript-required",
      status: "degraded",
      title: "优秀音频专访样本",
      sourceUrl: "https://example.com/interview-audio.mp3",
      text: "主持人：请补充转写稿。",
      degradedReason: "缺少 DASHSCOPE_API_KEY 或 BAILIAN_API_KEY。",
      createdAt: "2026-06-10T00:00:00.000Z"
    };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ transcription }), { status: 200 }));
    const client = createProductApiClient("http://127.0.0.1:8787", fetchImpl);

    const result = await client.transcribeCorpusAudio({
      title: "优秀音频专访样本",
      sourceUrl: "https://example.com/interview-audio.mp3",
      languageHint: "zh"
    });

    expect(fetchImpl).toHaveBeenCalledWith("http://127.0.0.1:8787/api/corpus/transcriptions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "优秀音频专访样本",
        sourceUrl: "https://example.com/interview-audio.mp3",
        languageHint: "zh"
      })
    });
    expect(result.transcription).toMatchObject({
      providerId: "local-fallback",
      status: "degraded",
      text: "主持人：请补充转写稿。"
    });
  });

  it("runs interview sessions through the API", async () => {
    const state = createInitialProductState();
    const session = createSessionDraft(state, "decision", "standard");
    const updatedSession = {
      ...session,
      turns: [
        {
          id: "turn-user-api",
          role: "user",
          content: "我怕放手后项目失控。",
          intent: "用户表达",
          timestamp: "2026-06-10T00:00:00.000Z"
        },
        {
          id: "turn-assistant-api",
          role: "assistant",
          content: "最坏的代价是什么？",
          intent: "追问机制",
          timestamp: "2026-06-10T00:00:01.000Z"
        }
      ]
    };
    const completedSession = { ...updatedSession, status: "completed" };
    const note = {
      id: "note-api",
      sessionId: session.id,
      title: session.title,
      summary: "摘要",
      keyQuote: "我怕放手后项目失控。",
      saidTrack: [],
      learnedTrack: [],
      nextQuestions: [],
      createdAt: "2026-06-10T00:00:02.000Z"
    };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ session, state }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ session: updatedSession, state }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ session: completedSession, note, state }), { status: 200 }));
    const client = createProductApiClient("http://127.0.0.1:8787", fetchImpl);

    const created = await client.createInterviewSession({
      mode: "decision",
      strength: "standard"
    });
    const turned = await client.sendInterviewTurn(session.id, {
      content: "我怕放手后项目失控。"
    });
    const ended = await client.endInterviewSession(session.id);

    expect(fetchImpl).toHaveBeenNthCalledWith(1, "http://127.0.0.1:8787/api/interview-sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: "decision",
        strength: "standard"
      })
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(2, `http://127.0.0.1:8787/api/interview-sessions/${session.id}/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content: "我怕放手后项目失控。"
      })
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(3, `http://127.0.0.1:8787/api/interview-sessions/${session.id}/end`, {
      method: "POST"
    });
    expect(created.session.id).toBe(session.id);
    expect(turned.session.turns).toHaveLength(2);
    expect(ended.note.sessionId).toBe(session.id);
    expect(ended.state.profile.name).toBe("Mia");
  });

  it("creates realtime voice sessions through the API", async () => {
    const response = {
      provider: "bailian",
      model: "qwen3.5-omni-plus-realtime",
      transport: "webrtc",
      status: "ready",
      sessionId: "rtv-api",
      signaling: {
        method: "POST",
        path: "/api/realtime-voice/sessions/rtv-api/webrtc/answer",
        contentType: "application/sdp"
      },
      sessionUpdate: {
        type: "session.update",
        session: {
          modalities: ["text", "audio"],
          voice: "Ethan",
          input_audio_format: "pcm",
          output_audio_format: "pcm",
          instructions: "你是一个真正的私人专访主持人。",
          turn_detection: {
            type: "server_vad",
            threshold: 0.5,
            silence_duration_ms: 800
          }
        }
      },
      expiresAt: "2026-06-10T00:10:00.000Z"
    };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(response), { status: 200 }));
    const client = createProductApiClient("http://127.0.0.1:8787", fetchImpl);

    const result = await client.createRealtimeVoiceSession({
      instructions: "你是一个真正的私人专访主持人。",
      interviewSessionId: "session-api"
    });

    expect(fetchImpl).toHaveBeenCalledWith("http://127.0.0.1:8787/api/realtime-voice/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        instructions: "你是一个真正的私人专访主持人。",
        interviewSessionId: "session-api"
      })
    });
    expect(result).toMatchObject({
      sessionId: "rtv-api",
      status: "ready",
      signaling: {
        path: "/api/realtime-voice/sessions/rtv-api/webrtc/answer"
      }
    });
  });

  it("exchanges realtime WebRTC SDP through the Product API proxy", async () => {
    const fetchImpl = vi.fn(async () => new Response("answer-sdp", { status: 200, headers: { "content-type": "application/sdp" } }));
    const client = createProductApiClient("http://127.0.0.1:8787", fetchImpl);

    const answerSdp = await client.exchangeRealtimeVoiceSdp("/api/realtime-voice/sessions/rtv-api/webrtc/answer", "offer-sdp");

    expect(fetchImpl).toHaveBeenCalledWith("http://127.0.0.1:8787/api/realtime-voice/sessions/rtv-api/webrtc/answer", {
      method: "POST",
      headers: { "content-type": "application/sdp" },
      body: "offer-sdp"
    });
    expect(answerSdp).toBe("answer-sdp");
  });

  it("confirms a decision candidate through the API", async () => {
    const state = createInitialProductState();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(state), { status: 200 }));
    const client = createProductApiClient("http://127.0.0.1:8787", fetchImpl);

    const result = await client.confirmDecision("decision-123");

    expect(fetchImpl).toHaveBeenCalledWith("http://127.0.0.1:8787/api/assets/decisions/decision-123/confirm", { method: "POST" });
    expect(result.profile.name).toBe("Mia");
  });

  it("reports unavailable API health without throwing", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const client = createProductApiClient("http://127.0.0.1:8787", fetchImpl);

    await expect(client.health()).resolves.toBe(false);
  });

  it("fetches export/backup rehearsal report from the API", async () => {
    const report = {
      schemaVersion: 1,
      generatedAt: "2026-06-19T00:00:00.000Z",
      strategy: "json-export-import-rehearsal",
      summary: { passed: 5, warning: 1, failed: 0 },
      package: {
        product: "interview-product-mvp",
        format: "product-state-json",
        exportedAt: "2026-06-19T00:00:00.000Z",
        stateBytes: 12345,
        stateDigest: "abc123",
        restoredDigest: "abc123",
        privacyReportIncluded: true,
        providerSecretsExcluded: true
      },
      privacyReport: {
        generatedAt: "2026-06-19T00:00:00.000Z",
        totalRecords: 10,
        hasPersonalData: true,
        inventory: [],
        operations: {
          exportAvailable: true,
          importAvailable: true,
          purgeAvailable: true,
          resetToDemoAvailable: true,
          providerSecretsExcluded: true,
          runtimeEnvPreservedOnPurge: true
        },
        retentionNotes: []
      },
      migrationManifest: { checks: [], runbook: [] },
      checks: [],
      runbook: []
    };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(report), { status: 200 }));
    const client = createProductApiClient("http://127.0.0.1:8787", fetchImpl);

    const result = await client.exportState();

    expect(fetchImpl).toHaveBeenCalledWith("http://127.0.0.1:8787/api/state/export", { method: "GET" });
    expect(result.schemaVersion).toBe(1);
    expect(result.strategy).toBe("json-export-import-rehearsal");
    expect(result.package.privacyReportIncluded).toBe(true);
  });

  it("fetches privacy report from the API", async () => {
    const report = {
      generatedAt: "2026-06-19T00:00:00.000Z",
      totalRecords: 42,
      hasPersonalData: true,
      inventory: [
        { id: "profile", label: "显性档案与边界", count: 5, detail: "...", exported: true, purged: true },
        { id: "interviews", label: "专访与双轨笔记", count: 3, detail: "...", exported: true, purged: true }
      ],
      operations: {
        exportAvailable: true,
        importAvailable: true,
        purgeAvailable: true,
        resetToDemoAvailable: true,
        providerSecretsExcluded: true,
        runtimeEnvPreservedOnPurge: true
      },
      retentionNotes: ["注意1", "注意2"]
    };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(report), { status: 200 }));
    const client = createProductApiClient("http://127.0.0.1:8787", fetchImpl);

    const result = await client.getPrivacyReport();

    expect(fetchImpl).toHaveBeenCalledWith("http://127.0.0.1:8787/api/state/privacy-report", { method: "GET" });
    expect(result.totalRecords).toBe(42);
    expect(result.hasPersonalData).toBe(true);
    expect(result.inventory).toHaveLength(2);
    expect(result.inventory[0].id).toBe("profile");
  });

  it("purges personal data through the API and returns normalized state", async () => {
    const state = createInitialProductState();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(state), { status: 200 }));
    const client = createProductApiClient("http://127.0.0.1:8787", fetchImpl);

    const result = await client.purgeState();

    expect(fetchImpl).toHaveBeenCalledWith("http://127.0.0.1:8787/api/state/purge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: "PURGE_PERSONAL_DATA" })
    });
    expect(result.profile.name).toBe("Mia");
  });
});
