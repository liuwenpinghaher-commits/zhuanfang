import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createInitialProductState } from "../../../src/domain/engine";
import { buildApiServer, isDirectCliExecution } from "./server";

describe("Product API", () => {
  const tempDirs: string[] = [];

  function createDbPath() {
    const dir = mkdtempSync(join(tmpdir(), "interview-api-db-"));
    tempDirs.push(dir);
    return join(dir, "state.sqlite");
  }

  function createEnvPath() {
    const dir = mkdtempSync(join(tmpdir(), "interview-api-env-"));
    tempDirs.push(dir);
    return join(dir, ".env.local");
  }

  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it("detects direct CLI execution when the workspace path contains spaces or non-ASCII characters", () => {
    expect(
      isDirectCliExecution(
        "file:///Users/miaoma/Downloads/%E4%B8%93%E8%AE%BF%201.0/apps/api/src/server.ts",
        "/Users/miaoma/Downloads/专访 1.0/apps/api/src/server.ts"
      )
    ).toBe(true);
  });

  it("responds to health checks", async () => {
    const server = buildApiServer();
    const response = await server.inject({ method: "GET", url: "/api/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, service: "interview-product-api" });
  });

  it("allows browser clients on the Vite dev origin to call the Product API", async () => {
    const server = buildApiServer();

    const preflight = await server.inject({
      method: "OPTIONS",
      url: "/api/system/capabilities",
      headers: {
        origin: "http://127.0.0.1:5173",
        "access-control-request-method": "GET"
      }
    });
    const response = await server.inject({
      method: "GET",
      url: "/api/health",
      headers: {
        origin: "http://127.0.0.1:5173"
      }
    });

    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers["access-control-allow-origin"]).toBe("http://127.0.0.1:5173");
    expect(response.statusCode).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBe("http://127.0.0.1:5173");
  });

  it("reports system capabilities without exposing secret values", async () => {
    const server = buildApiServer({
      env: {
        DASHSCOPE_API_KEY: "secret-dashscope-key",
        ANYSEARCH_API_KEY: "secret-anysearch-key",
        BAILIAN_REALTIME_WEBRTC_ENDPOINT: "https://realtime.example.com"
      },
      bailianSearchClient: {
        async createSearchBrief() {
          throw new Error("not called");
        }
      },
      anySearchClient: {
        async createSearchBrief() {
          throw new Error("not called");
        }
      },
      bailianPodcastAudioClient: {
        async synthesize() {
          throw new Error("not called");
        }
      },
      bailianInterviewClient: {
        async createAssistantTurn() {
          throw new Error("not called");
        }
      },
      bailianRealtimeVoiceClient: {
        async createWebrtcAnswer() {
          throw new Error("not called");
        }
      },
      bailianTranscriptionClient: {
        async transcribe() {
          throw new Error("not called");
        }
      }
    });

    const response = await server.inject({ method: "GET", url: "/api/system/capabilities" });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body).toMatchObject({
      configVersion: "local-demo-2026.06.10",
      runtime: {
        service: "interview-product-api",
        stateStore: "memory"
      },
      capabilities: expect.arrayContaining([
        expect.objectContaining({ id: "bailian-responses", status: "ready", active: true }),
        expect.objectContaining({ id: "anysearch", status: "ready", requiredEnv: ["ANYSEARCH_API_KEY"] }),
        expect.objectContaining({ id: "bailian-cosyvoice", status: "ready" }),
        expect.objectContaining({ id: "bailian-sensevoice", status: "ready" }),
        expect.objectContaining({ id: "bailian-character", status: "ready" }),
        expect.objectContaining({ id: "bailian-realtime", status: "ready" })
      ])
    });
    expect(JSON.stringify(body)).not.toContain("secret-dashscope-key");
    expect(JSON.stringify(body)).not.toContain("secret-anysearch-key");
  });

  it("returns editable runtime configuration with masked secret values", async () => {
    const envFilePath = createEnvPath();
    writeFileSync(envFilePath, "DASHSCOPE_API_KEY=secret-dashscope-key\nBAILIAN_SEARCH_MODEL=qwen3.7-plus\n");
    const server = buildApiServer({
      envFilePath,
      env: {
        DASHSCOPE_API_KEY: "secret-dashscope-key",
        BAILIAN_SEARCH_MODEL: "qwen3.7-plus"
      }
    });

    const response = await server.inject({ method: "GET", url: "/api/system/config" });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body).toMatchObject({
      envFilePath,
      sections: expect.arrayContaining([
        expect.objectContaining({
          id: "secrets",
          settings: expect.arrayContaining([
            expect.objectContaining({
              key: "DASHSCOPE_API_KEY",
              secret: true,
              configured: true,
              value: null,
              maskedValue: expect.stringContaining("已配置")
            })
          ])
        }),
        expect.objectContaining({
          id: "models",
          settings: expect.arrayContaining([
            expect.objectContaining({
              key: "BAILIAN_SEARCH_MODEL",
              value: "qwen3.7-plus",
              configured: true
            })
          ])
        })
      ])
    });
    expect(JSON.stringify(body)).not.toContain("secret-dashscope-key");
  });

  it("updates runtime configuration, persists it to env file, and refreshes provider health", async () => {
    const envFilePath = createEnvPath();
    writeFileSync(envFilePath, "# local runtime config\n");
    const env: Record<string, string | undefined> = {};
    const server = buildApiServer({ envFilePath, env });

    const response = await server.inject({
      method: "PATCH",
      url: "/api/system/config",
      payload: {
        updates: {
          DASHSCOPE_API_KEY: "secret-dashscope-key",
          BAILIAN_SEARCH_MODEL: "qwen3.7-plus",
          ANYSEARCH_ALLOW_ANONYMOUS: "true",
          BAILIAN_REALTIME_WEBRTC_ENDPOINT: "https://realtime.example.com"
        }
      }
    });
    const body = response.json();
    const envFileContent = readFileSync(envFilePath, "utf8");
    const capabilitiesResponse = await server.inject({ method: "GET", url: "/api/system/capabilities" });
    const capabilities = capabilitiesResponse.json().capabilities;

    expect(response.statusCode).toBe(200);
    expect(body.settingsUpdated).toEqual([
      "DASHSCOPE_API_KEY",
      "BAILIAN_SEARCH_MODEL",
      "ANYSEARCH_ALLOW_ANONYMOUS",
      "BAILIAN_REALTIME_WEBRTC_ENDPOINT"
    ]);
    expect(JSON.stringify(body)).not.toContain("secret-dashscope-key");
    expect(envFileContent).toContain("DASHSCOPE_API_KEY=secret-dashscope-key");
    expect(envFileContent).toContain("BAILIAN_SEARCH_MODEL=qwen3.7-plus");
    expect(envFileContent).toContain("ANYSEARCH_ALLOW_ANONYMOUS=true");
    expect(env.DASHSCOPE_API_KEY).toBe("secret-dashscope-key");
    expect(capabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "bailian-responses", status: "ready" }),
        expect.objectContaining({ id: "bailian-cosyvoice", status: "ready" }),
        expect.objectContaining({ id: "bailian-sensevoice", status: "ready" }),
        expect.objectContaining({ id: "bailian-character", status: "ready" }),
        expect.objectContaining({ id: "bailian-realtime", status: "ready" }),
        expect.objectContaining({ id: "anysearch", status: "ready" })
      ])
    );
  });

  it("marks realtime voice as needing endpoint when the API key exists but WebRTC endpoint is missing", async () => {
    const server = buildApiServer({
      env: {
        DASHSCOPE_API_KEY: "secret-dashscope-key",
        BAILIAN_REALTIME_TRANSPORT: "webrtc"
      }
    });

    const response = await server.inject({ method: "GET", url: "/api/system/capabilities" });
    const realtime = response.json().capabilities.find((capability: { id: string }) => capability.id === "bailian-realtime");

    expect(response.statusCode).toBe(200);
    expect(realtime).toMatchObject({
      status: "needs-endpoint",
      requiredEnv: ["DASHSCOPE_API_KEY", "BAILIAN_REALTIME_WEBRTC_ENDPOINT"]
    });
  });

  it("returns the current product state", async () => {
    const server = buildApiServer();
    const response = await server.inject({ method: "GET", url: "/api/state" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      profile: { name: "Mia" },
      notes: expect.any(Array),
      systemConfig: expect.any(Object)
    });
  });

  it("resets the demo state", async () => {
    const server = buildApiServer();
    const response = await server.inject({ method: "POST", url: "/api/state/reset" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      profile: { name: "Mia" },
      notes: expect.any(Array)
    });
  });

  it("creates and persists search briefs through the Product API", async () => {
    const server = buildApiServer();

    const response = await server.inject({
      method: "POST",
      url: "/api/search/briefs",
      payload: {
        topic: "AI 产品商业化热点",
        providerId: "anysearch",
        maxSources: 3,
        recencyDays: 14
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      brief: {
        topic: "AI 产品商业化热点",
        provider: "anysearch",
        sources: expect.any(Array)
      },
      task: {
        status: "degraded",
        providerId: "anysearch"
      },
      state: {
        searchBriefs: expect.any(Array)
      }
    });

    const stateResponse = await server.inject({ method: "GET", url: "/api/state" });
    expect(stateResponse.json().searchBriefs[0]).toMatchObject({
      topic: "AI 产品商业化热点",
      provider: "anysearch"
    });
  });

  it("uses Bailian built-in web search when the provider client is configured", async () => {
    const server = buildApiServer({
      bailianSearchClient: {
        async createSearchBrief(input) {
          return {
            topic: input.topic,
            provider: "bailian",
            status: "ready",
            summary: "百炼内置联网返回的摘要。",
            facts: ["百炼事实"],
            controversies: ["百炼争议"],
            opposingViews: ["百炼反方观点"],
            interviewAngles: ["百炼专访角度"],
            discussionTopics: ["百炼联网主题"],
            sourceAngles: ["百炼来源角度"],
            sources: [
              {
                id: "source-bailian-test",
                title: "百炼联网来源",
                url: "https://example.com/bailian",
                publisher: "Bailian Test",
                publishedAt: "2026-06-10T00:00:00.000Z",
                snippet: "百炼内置联网素材。",
                relevanceScore: 0.95,
                usage: "topic-suggestion"
              }
            ]
          };
        }
      }
    });

    const response = await server.inject({
      method: "POST",
      url: "/api/search/briefs",
      payload: {
        topic: "AI 产品商业化热点",
        providerId: "bailian",
        maxSources: 3,
        recencyDays: 14
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      brief: {
        provider: "bailian",
        status: "ready",
        sources: [{ publisher: "Bailian Test" }]
      },
      task: {
        status: "succeeded",
        providerId: "bailian"
      }
    });
  });

  it("uses AnySearch when the provider client is configured", async () => {
    const server = buildApiServer({
      anySearchClient: {
        async createSearchBrief(input) {
          return {
            topic: input.topic,
            provider: "anysearch",
            status: "ready",
            summary: "AnySearch 返回的联网摘要。",
            facts: ["AnySearch 事实"],
            controversies: ["AnySearch 争议"],
            opposingViews: ["AnySearch 反方观点"],
            interviewAngles: ["AnySearch 专访角度"],
            discussionTopics: ["AnySearch 讨论主题"],
            sourceAngles: ["AnySearch 来源角度"],
            sources: [
              {
                id: "source-anysearch-test",
                title: "AnySearch 联网来源",
                url: "https://example.com/anysearch",
                publisher: "AnySearch Test",
                publishedAt: "2026-06-10T00:00:00.000Z",
                snippet: "AnySearch 联网素材。",
                relevanceScore: 0.94,
                usage: "topic-suggestion"
              }
            ]
          };
        }
      }
    });

    const response = await server.inject({
      method: "POST",
      url: "/api/search/briefs",
      payload: {
        topic: "AI 产品商业化热点",
        providerId: "anysearch",
        maxSources: 3,
        recencyDays: 14
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      brief: {
        provider: "anysearch",
        status: "ready",
        facts: ["AnySearch 事实"],
        controversies: ["AnySearch 争议"],
        opposingViews: ["AnySearch 反方观点"],
        interviewAngles: ["AnySearch 专访角度"],
        sources: [{ publisher: "AnySearch Test" }]
      },
      task: {
        status: "succeeded",
        providerId: "anysearch"
      }
    });
  });

  it("creates and persists podcast episodes through the Product API", async () => {
    const server = buildApiServer();
    const stateResponse = await server.inject({ method: "GET", url: "/api/state" });
    const noteId = stateResponse.json().notes[0].id;

    const response = await server.inject({
      method: "POST",
      url: "/api/podcast/episodes",
      payload: {
        noteId,
        format: "solo",
        voice: "calm-host"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      episode: {
        noteId,
        format: "solo",
        voice: "calm-host",
        status: "draft"
      },
      state: {
        podcastEpisodes: expect.any(Array)
      }
    });

    const persistedStateResponse = await server.inject({ method: "GET", url: "/api/state" });
    expect(persistedStateResponse.json().podcastEpisodes[0]).toMatchObject({
      noteId,
      voice: "calm-host"
    });
  });

  it("analyzes and persists imported interview corpus through the Product API", async () => {
    const server = buildApiServer();

    const response = await server.inject({
      method: "POST",
      url: "/api/corpus/insights",
      payload: {
        title: "优秀专访样本",
        mediaType: "text",
        content:
          "主持人：你刚才说增长很难，能不能讲一个具体时刻？\n被访者：真正困难是团队不敢暴露坏消息。\n主持人：如果反过来看，是不是机制奖励了报喜不报忧？"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      insight: {
        title: "优秀专访样本：访谈逻辑分析",
        dimensions: expect.any(Array),
        recommendedPatches: expect.any(Array)
      },
      state: {
        corpusInsights: expect.any(Array),
        playbookPatches: expect.any(Array)
      }
    });

    const stateResponse = await server.inject({ method: "GET", url: "/api/state" });
    expect(stateResponse.json().corpusInsights[0]).toMatchObject({
      title: "优秀专访样本：访谈逻辑分析"
    });
  });

  it("returns a degraded audio transcription draft when ASR is not configured", async () => {
    const server = buildApiServer();

    const response = await server.inject({
      method: "POST",
      url: "/api/corpus/transcriptions",
      payload: {
        title: "音频专访样本",
        sourceUrl: "https://example.com/interview-audio.mp3"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      transcription: {
        providerId: "local-fallback",
        model: "manual-transcript-required",
        status: "degraded",
        title: "音频专访样本",
        sourceUrl: "https://example.com/interview-audio.mp3",
        degradedReason: "缺少 DASHSCOPE_API_KEY 或 BAILIAN_API_KEY，无法调用百炼 SenseVoice 录音转写。"
      }
    });
    expect(response.json().transcription.text).toContain("主持人：");
  });

  it("transcribes imported audio through the configured Bailian ASR client", async () => {
    const server = buildApiServer({
      bailianTranscriptionClient: {
        async transcribe(input) {
          expect(input).toEqual({
            title: "音频专访样本",
            sourceUrl: "https://example.com/interview-audio.mp3",
            languageHint: "zh"
          });
          return {
            providerId: "bailian-sensevoice",
            model: "sensevoice-v1",
            sourceUrl: input.sourceUrl,
            taskId: "task-audio-1",
            transcriptionUrl: "https://transcription.example.com/result.json",
            durationSec: 28,
            text: "主持人：能不能讲一个具体时刻？\n被访者：他们只等我拍板。"
          };
        }
      }
    });

    const response = await server.inject({
      method: "POST",
      url: "/api/corpus/transcriptions",
      payload: {
        title: "音频专访样本",
        sourceUrl: "https://example.com/interview-audio.mp3",
        languageHint: "zh"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      transcription: {
        providerId: "bailian-sensevoice",
        model: "sensevoice-v1",
        status: "ready",
        title: "音频专访样本",
        sourceUrl: "https://example.com/interview-audio.mp3",
        text: "主持人：能不能讲一个具体时刻？\n被访者：他们只等我拍板。",
        taskId: "task-audio-1",
        durationSec: 28
      }
    });
  });

  it("runs an interview session through the Product API and persists the generated note", async () => {
    const server = buildApiServer();

    const createResponse = await server.inject({
      method: "POST",
      url: "/api/interview-sessions",
      payload: {
        mode: "decision",
        strength: "standard"
      }
    });

    expect(createResponse.statusCode).toBe(200);
    const createdSession = createResponse.json().session;
    expect(createdSession).toMatchObject({
      mode: "decision",
      strength: "standard",
      status: "active",
      turns: []
    });

    const turnResponse = await server.inject({
      method: "POST",
      url: `/api/interview-sessions/${createdSession.id}/turns`,
      payload: {
        content: "我不想每次都替团队兜底，但又怕放手之后项目失控。"
      }
    });

    expect(turnResponse.statusCode).toBe(200);
    expect(turnResponse.json().session.turns).toHaveLength(2);
    expect(turnResponse.json().session.turns[1]).toMatchObject({
      role: "assistant",
      intent: "追问机制"
    });

    const controlResponse = await server.inject({
      method: "POST",
      url: `/api/interview-sessions/${createdSession.id}/control`,
      payload: {
        action: "softer"
      }
    });

    expect(controlResponse.statusCode).toBe(200);
    expect(controlResponse.json().session).toMatchObject({
      strength: "gentle"
    });

    const endResponse = await server.inject({
      method: "POST",
      url: `/api/interview-sessions/${createdSession.id}/end`
    });

    expect(endResponse.statusCode).toBe(200);
    expect(endResponse.json()).toMatchObject({
      note: {
        sessionId: createdSession.id,
        title: expect.stringContaining("决策专访")
      },
      session: {
        id: createdSession.id,
        status: "completed"
      },
      state: {
        notes: expect.any(Array),
        sessions: expect.any(Array)
      }
    });
    expect(endResponse.json().state.sessions.filter((session: { id: string }) => session.id === createdSession.id)).toHaveLength(1);

    const stateResponse = await server.inject({ method: "GET", url: "/api/state" });
    expect(stateResponse.json().notes[0]).toMatchObject({
      sessionId: createdSession.id
    });
    expect(stateResponse.json().sessions[0]).toMatchObject({
      id: createdSession.id,
      status: "completed"
    });
  });

  it("uses Bailian Character interview client when it is configured", async () => {
    const server = buildApiServer({
      bailianInterviewClient: {
        async createAssistantTurn(input) {
          expect(input.session.mode).toBe("decision");
          expect(input.userText).toBe("我怕放手后项目失控。");
          return {
            providerId: "bailian-character",
            model: "qwen-plus-character",
            content: "先别急着解释，我们把失控拆成延期、质量、客户和团队信任四类。",
            intent: "百炼角色扮演追问"
          };
        }
      }
    });

    const createResponse = await server.inject({
      method: "POST",
      url: "/api/interview-sessions",
      payload: {
        mode: "decision"
      }
    });
    const sessionId = createResponse.json().session.id;

    const turnResponse = await server.inject({
      method: "POST",
      url: `/api/interview-sessions/${sessionId}/turns`,
      payload: {
        content: "我怕放手后项目失控。"
      }
    });

    expect(turnResponse.statusCode).toBe(200);
    expect(turnResponse.json().session.turns[1]).toMatchObject({
      role: "assistant",
      content: "先别急着解释，我们把失控拆成延期、质量、客户和团队信任四类。",
      intent: "百炼角色扮演追问"
    });
  });

  it("persists state through SQLite when a database path is configured", async () => {
    const dbPath = createDbPath();
    const state = createInitialProductState();
    const changedState = {
      ...state,
      profile: {
        ...state.profile,
        currentFocus: "API 数据库持久化"
      }
    };
    const firstServer = buildApiServer({ productStateDbPath: dbPath });

    const saveResponse = await firstServer.inject({ method: "PUT", url: "/api/state", payload: changedState });
    expect(saveResponse.statusCode).toBe(200);
    await firstServer.close();

    const secondServer = buildApiServer({ productStateDbPath: dbPath });
    const readResponse = await secondServer.inject({ method: "GET", url: "/api/state" });

    expect(readResponse.statusCode).toBe(200);
    expect(readResponse.json().profile.currentFocus).toBe("API 数据库持久化");
    await secondServer.close();
  });

  it("renders podcast audio through Bailian CosyVoice when the audio client is configured", async () => {
    const server = buildApiServer({
      bailianPodcastAudioClient: {
        async synthesize(input) {
          expect(input.text).toContain("开场：今天我们回到");
          expect(input.voice).toBeUndefined();
          return {
            providerId: "bailian-cosyvoice",
            model: "cosyvoice-v3-plus",
            voice: "longyuan_v3",
            audioUrl: "https://dashscope-result.example.com/podcast.mp3",
            expiresAt: 1791705600
          };
        }
      }
    });
    const stateResponse = await server.inject({ method: "GET", url: "/api/state" });
    const noteId = stateResponse.json().notes[0].id;

    const response = await server.inject({
      method: "POST",
      url: "/api/podcast/episodes",
      payload: {
        noteId,
        format: "solo",
        voice: "calm-host"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      episode: {
        noteId,
        voice: "longyuan_v3",
        audioUrl: "https://dashscope-result.example.com/podcast.mp3"
      }
    });

    const persistedStateResponse = await server.inject({ method: "GET", url: "/api/state" });
    expect(persistedStateResponse.json().podcastEpisodes[0]).toMatchObject({
      noteId,
      voice: "longyuan_v3",
      audioUrl: "https://dashscope-result.example.com/podcast.mp3"
    });
  });

  it("returns safe realtime voice configuration without exposing API keys", async () => {
    const previousKey = process.env.DASHSCOPE_API_KEY;
    process.env.DASHSCOPE_API_KEY = "secret-that-must-not-leak";
    const server = buildApiServer();

    const response = await server.inject({ method: "GET", url: "/api/realtime-voice/config" });

    expect(response.statusCode).toBe(200);
    expect(JSON.stringify(response.json())).not.toContain("secret-that-must-not-leak");
    expect(response.json()).toMatchObject({
      provider: "bailian",
      model: "qwen3.5-omni-plus-realtime",
      fallbackModel: "qwen3.5-omni-flash-realtime",
      transport: "websocket",
      fallbackTransport: "websocket",
      vad: "server_vad",
      enableSearch: false,
      configured: true,
      requiresServerSession: true
    });

    if (previousKey === undefined) {
      delete process.env.DASHSCOPE_API_KEY;
    } else {
      process.env.DASHSCOPE_API_KEY = previousKey;
    }
  });

  it("creates safe realtime voice sessions and proxies WebRTC SDP exchange", async () => {
    const previousKey = process.env.DASHSCOPE_API_KEY;
    process.env.DASHSCOPE_API_KEY = "test-key";
    const server = buildApiServer({
      bailianRealtimeVoiceClient: {
        async createWebrtcAnswer(input) {
          expect(input).toEqual({
            model: "qwen3.5-omni-plus-realtime",
            offerSdp: "offer-sdp"
          });
          return "answer-sdp";
        }
      }
    });

    const sessionResponse = await server.inject({
      method: "POST",
      url: "/api/realtime-voice/sessions",
      payload: {
        instructions: "你是一个真正的私人专访主持人。"
      }
    });

    expect(sessionResponse.statusCode).toBe(200);
    expect(JSON.stringify(sessionResponse.json())).not.toContain("Bearer");
    expect(sessionResponse.json()).toMatchObject({
      provider: "bailian",
      model: "qwen3.5-omni-plus-realtime",
      transport: "websocket",
      status: "ready",
      sessionUpdate: {
        type: "session.update",
        session: {
          modalities: ["text", "audio"],
          input_audio_format: "pcm",
          output_audio_format: "pcm",
          instructions: "你是一个真正的私人专访主持人。",
          turn_detection: {
            type: "server_vad",
            silence_duration_ms: 800
          }
        }
      }
    });
    expect(sessionResponse.json().signaling).toEqual({
      method: "POST",
      path: `/api/realtime-voice/sessions/${sessionResponse.json().sessionId}/webrtc/answer`,
      contentType: "application/sdp"
    });

    const answerResponse = await server.inject({
      method: "POST",
      url: `/api/realtime-voice/sessions/${sessionResponse.json().sessionId}/webrtc/answer`,
      headers: {
        "content-type": "application/sdp"
      },
      payload: "offer-sdp"
    });

    expect(answerResponse.statusCode).toBe(200);
    expect(answerResponse.headers["content-type"]).toContain("application/sdp");
    expect(answerResponse.body).toBe("answer-sdp");

    if (previousKey === undefined) {
      delete process.env.DASHSCOPE_API_KEY;
    } else {
      process.env.DASHSCOPE_API_KEY = previousKey;
    }
  });

  describe("PRODUCT_STATIC_DIR static file serving (P0-4)", () => {
    it("serves index.html from PRODUCT_STATIC_DIR when env is set", async () => {
      const staticDir = mkdtempSync(join(tmpdir(), "interview-static-"));
      tempDirs.push(staticDir);
      writeFileSync(join(staticDir, "index.html"), "<html><body>hello static</body></html>");

      const server = buildApiServer({
        env: { PRODUCT_STATIC_DIR: staticDir }
      });

      const response = await server.inject({ method: "GET", url: "/" });

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain("hello static");
    });

    it("does not serve static files when PRODUCT_STATIC_DIR is not set", async () => {
      const server = buildApiServer({ env: {} });

      const response = await server.inject({ method: "GET", url: "/" });

      // Without static serving, / is not a registered route → 404
      expect(response.statusCode).toBe(404);
    });

    it("API routes still work when PRODUCT_STATIC_DIR is set", async () => {
      const staticDir = mkdtempSync(join(tmpdir(), "interview-static-"));
      tempDirs.push(staticDir);
      writeFileSync(join(staticDir, "index.html"), "<html><body>hello static</body></html>");

      const server = buildApiServer({
        env: { PRODUCT_STATIC_DIR: staticDir }
      });

      const response = await server.inject({ method: "GET", url: "/api/health" });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true, service: "interview-product-api" });
    });
  });
});
