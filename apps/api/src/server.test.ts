import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApiServer, isDirectCliExecution, createGracefulShutdown } from "./server";
import {
  createFakeChatClient,
  createFakeEmbeddingClient,
  createFakeInterviewClient
} from "./test-helpers/fake-llm-clients";

describe("Product API", () => {
  const tempDirs: string[] = [];

  function createEnvPath() {
    const dir = mkdtempSync(join(tmpdir(), "interview-api-env-"));
    tempDirs.push(dir);
    return join(dir, ".env.local");
  }

  afterEach(() => {
    vi.unstubAllGlobals();
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

  it("serializes concurrent state-mutating requests so none are lost (P0-1)", async () => {
    // Every write endpoint does getState → await(LLM/embedding) → replaceState with no
    // optimistic lock. Two writes racing through the await window would both read the same
    // base snapshot and the second replaceState would clobber the first. We force the window
    // open with a slow embedding client (create-session embeds its recall topic), fire several
    // creates concurrently, and assert ALL of them persisted — i.e. writes ran one-at-a-time.
    const slowEmbeddingClient = {
      embed: async (_texts: string[]) => {
        await new Promise((r) => setTimeout(r, 20));
        return [[0.1, 0.2, 0.3]];
      }
    };
    const server = buildApiServer({ embeddingClient: slowEmbeddingClient as never });
    const N = 4;
    await Promise.all(
      Array.from({ length: N }, (_v, i) =>
        server.inject({ method: "POST", url: "/api/interview-sessions", payload: { mode: "daily", topicHint: `并发主题${i}` } })
      )
    );
    const state = (await server.inject({ method: "GET", url: "/api/state" })).json();
    expect(state.sessions.length).toBe(N); // no lost-update: every concurrent create survived
    await server.close();
  });

  it("returns a generic 500 without leaking internal error details when a handler throws (P1)", async () => {
    // Inject a repository whose getState throws so GET /api/state hits an UNCAUGHT error.
    // Fastify's default handler would echo the raw error message; the global error handler
    // must replace it with a generic body so internals/secrets never reach the client.
    const throwingRepo = {
      getState: () => {
        throw new Error("SECRET_INTERNAL_STACK_DETAIL");
      }
    } as never;
    const server = buildApiServer({ productStateRepository: throwingRepo });
    const res = await server.inject({ method: "GET", url: "/api/state" });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain("SECRET_INTERNAL_STACK_DETAIL");
    expect(res.json().error).toBe("Internal Server Error");
    await server.close();
  });

  it("responds to health checks", async () => {
    const server = buildApiServer();
    const response = await server.inject({ method: "GET", url: "/api/health" });

    expect(response.statusCode).toBe(200);
expect(response.json()).toMatchObject({ ok: true, ready: true, service: "interview-product-api" });
  });

  it("allows browser clients on the Vite dev origin to call the Product API", async () => {
    const server = buildApiServer();

    const preflight = await server.inject({
      method: "OPTIONS",
      url: "/api/system/capabilities",
      headers: {
        origin: "http://127.0.0.1:3220",
        "access-control-request-method": "GET"
      }
    });
    const response = await server.inject({
      method: "GET",
      url: "/api/health",
      headers: {
        origin: "http://127.0.0.1:3220"
      }
    });

    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers["access-control-allow-origin"]).toBe("http://127.0.0.1:3220");
    expect(response.statusCode).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBe("http://127.0.0.1:3220");
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
      // 审计修复(F-02/A2):未传 productStoreMode 时按 stateStore 如实回落,绝不按 env 谎报档位。
      productStore: "memory",
      runtime: {
        service: "interview-product-api",
        stateStore: "memory"
      },
      capabilities: expect.arrayContaining([
        expect.objectContaining({ id: "bailian-responses", status: "ready", active: true }),
        expect.objectContaining({
          id: "anysearch",
          status: "degraded",
          configured: true,
          availability: "unknown",
          requiredEnv: ["ANYSEARCH_API_KEY"],
        }),
        expect.objectContaining({ id: "bailian-cosyvoice", status: "ready" }),
        expect.objectContaining({ id: "bailian-sensevoice", status: "ready" }),
        expect.objectContaining({ id: "bailian-character", status: "ready" }),
        expect.objectContaining({ id: "bailian-realtime", status: "ready" })
      ])
    });
    expect(JSON.stringify(body)).not.toContain("secret-dashscope-key");
    expect(JSON.stringify(body)).not.toContain("secret-anysearch-key");
  });

  // 审计修复(F-02/A2):capabilities 的 productStore 只信 startServer 解析后显式传入的档位,
  // 不再读 env.PRODUCT_STORE——E2E globalSetup 靠这个字段熔断"测试连上真实存储"。
  // R7:档位仅 memory|surreal;这里注入 surreal 档,env 里给个内存档也不该被信任。
  it("reports the injected productStoreMode instead of trusting env.PRODUCT_STORE", async () => {
    const server = buildApiServer({
      productStoreMode: "surreal",
      env: { PRODUCT_STORE: "memory" }
    });

    const body = (await server.inject({ method: "GET", url: "/api/system/capabilities" })).json();
    expect(body.productStore).toBe("surreal");
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
        expect.objectContaining({ id: "anysearch", status: "degraded", configured: true, availability: "unknown" })
      ])
    );
  });

  it("F-02 事故收口:传入 envFilePath 后 PATCH config 只写该文件,绝不碰 cwd 的 .env.local", async () => {
    // 事故背景(2026-07-10):Playwright 实跑中陈旧 mock 未拦截,PATCH /api/system/config 打到
    // webServer 起的真实 API,writeEnvFileUpdates 按默认 join(process.cwd(), ".env.local") 把
    // 仓库根 .env.local 的真实 DASHSCOPE_API_KEY 覆盖成测试占位值。本测试钉死产品级防线:
    // buildApiServer 显式传入 envFilePath(startServer 经 PRODUCT_ENV_FILE 注入)时,config
    // 写盘只落隔离文件,cwd 的 .env.local 字节不变。
    const isolatedEnvFilePath = createEnvPath();
    writeFileSync(isolatedEnvFilePath, "# isolated runtime config\n");
    const cwdEnvFilePath = join(process.cwd(), ".env.local");
    const cwdEnvBefore = existsSync(cwdEnvFilePath) ? readFileSync(cwdEnvFilePath, "utf8") : null;
    const server = buildApiServer({ envFilePath: isolatedEnvFilePath, env: {} });

    const response = await server.inject({
      method: "PATCH",
      url: "/api/system/config",
      payload: { updates: { BAILIAN_SEARCH_MODEL: "isolated-env-file-marker" } }
    });

    expect(response.statusCode).toBe(200);
    // 更新落在隔离文件里。
    expect(readFileSync(isolatedEnvFilePath, "utf8")).toContain("BAILIAN_SEARCH_MODEL=isolated-env-file-marker");
    // cwd 的 .env.local 原样:不新建、不改写、一个字节都不动。
    const cwdEnvAfter = existsSync(cwdEnvFilePath) ? readFileSync(cwdEnvFilePath, "utf8") : null;
    expect(cwdEnvAfter).toBe(cwdEnvBefore);
    if (cwdEnvAfter !== null) {
      expect(cwdEnvAfter).not.toContain("isolated-env-file-marker");
    }
    await server.close();
  });

  it("uses refreshed AnySearch provider client in search routes after runtime config PATCH", async () => {
    const envFilePath = createEnvPath();
    writeFileSync(envFilePath, "# local runtime config\n");
    const env: Record<string, string | undefined> = {};
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      code: 0,
      data: {
        results: [
          {
            title: "Runtime AnySearch Source",
            url: "https://news.example/runtime-anysearch",
            snippet: "Runtime AnySearch snippet",
            content: "Runtime AnySearch content proves the refreshed client was used."
          }
        ],
        metadata: { request_id: "runtime-anysearch-test" }
      }
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchImpl);

    const server = buildApiServer({ envFilePath, env });
    const configRes = await server.inject({
      method: "PATCH",
      url: "/api/system/config",
      payload: {
        updates: {
          ANYSEARCH_ALLOW_ANONYMOUS: "true",
          ANYSEARCH_BASE_URL: "https://mock-anysearch.example"
        }
      }
    });
    const capabilities = (await server.inject({ method: "GET", url: "/api/system/capabilities" })).json().capabilities;
    const anysearchBeforeRequest = capabilities.find((capability: { id: string }) => capability.id === "anysearch");

    const searchRes = await server.inject({
      method: "POST",
      url: "/api/search/briefs",
      payload: {
        topic: "runtime provider refresh",
        providerId: "anysearch",
        maxSources: 1,
        recencyDays: 7
      }
    });
    const body = searchRes.json();
    const capabilitiesAfterRequest = (await server.inject({ method: "GET", url: "/api/system/capabilities" })).json().capabilities;
    const anysearchAfterRequest = capabilitiesAfterRequest.find((capability: { id: string }) => capability.id === "anysearch");

    expect(configRes.statusCode).toBe(200);
    expect(anysearchBeforeRequest).toMatchObject({ status: "degraded", configured: true, availability: "unknown" });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://mock-anysearch.example/v1/search",
      expect.objectContaining({ method: "POST" })
    );
    expect(searchRes.statusCode).toBe(200);
    expect(body.task).toMatchObject({ status: "succeeded", providerId: "anysearch" });
    expect(body.brief.sources[0].url).toBe("https://news.example/runtime-anysearch");
    expect(anysearchAfterRequest).toMatchObject({ status: "ready", configured: true, availability: "available" });
    await server.close();
  });

  it("marks realtime voice ready for webrtc with API key only (public signaling default, no whitelist)", async () => {
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
      status: "ready",
      requiredEnv: ["DASHSCOPE_API_KEY"]
    });
    // WebRTC no longer requires a whitelisted endpoint env; public DashScope default is used.
    expect(String(realtime.detail ?? "")).toMatch(/WebRTC|signaling|webrtc/i);
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
    const response = await server.inject({ method: "POST", url: "/api/state/reset", payload: { confirm: "RESET_ALL_DATA" } });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      profile: { name: "Mia" },
      notes: expect.any(Array)
    });
  });

  // 真实性重构:联网 provider 未配置 client 时不再用 local-demo 占位简报冒充（degraded 兜底已删）。
  // 成功持久化路径改为用户【显式选择】local-demo 演示 provider（唯一保留的确定性简报入口）。
  it("creates and persists search briefs through the Product API (explicit local-demo provider)", async () => {
    const server = buildApiServer();

    const response = await server.inject({
      method: "POST",
      url: "/api/search/briefs",
      payload: {
        topic: "AI 产品商业化热点",
        providerId: "local-demo",
        maxSources: 3,
        recencyDays: 14
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      brief: {
        topic: "AI 产品商业化热点",
        provider: "local-demo",
        sources: expect.any(Array)
      },
      task: {
        status: "succeeded",
        providerId: "local-demo"
      },
      state: {
        searchBriefs: expect.any(Array)
      }
    });

    const stateResponse = await server.inject({ method: "GET", url: "/api/state" });
    expect(stateResponse.json().searchBriefs[0]).toMatchObject({
      topic: "AI 产品商业化热点",
      provider: "local-demo"
    });
  });

  // 真实性重构:选定联网 provider 但无对应 client → 如实 503（不能用就暴露）。
  it("returns 503 when a networked search provider is selected without its client", async () => {
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

    expect(response.statusCode).toBe(503);
    expect(response.json().error).toContain("AnySearch 未配置");
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

  it("uses AnySearch when the provider client is configured", { timeout: 15_000 }, async () => {
    const server = buildApiServer({
      // Isolate env so Bailian chat is not auto-created and forced into insight synthesis (502).
      env: {
        DASHSCOPE_API_KEY: "",
        BAILIAN_API_KEY: ""
      },
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
    // 真实性重构:note 路径播客脚本是 LLM 必选能力（无 client → 503），注入假 chat client 走真实脚本生成路径。
    // 无 TTS client 时创建仍 200,audioRenderStatus 保持 "pending"（尚未渲染是诚实状态）。
    const server = buildApiServer({ bailianChatClient: createFakeChatClient() });
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
        voice: "longanyang",
        status: "draft",
        audioRenderStatus: "pending"
      },
      state: {
        podcastEpisodes: expect.any(Array)
      }
    });
    expect(response.json().episode.script).toContain("播客脚本正文");

    const persistedStateResponse = await server.inject({ method: "GET", url: "/api/state" });
    expect(persistedStateResponse.json().podcastEpisodes[0]).toMatchObject({
      noteId,
      voice: "longanyang"
    });
  });

  it("analyzes and persists imported interview corpus through the Product API", async () => {
    // 真实性重构:语料分析是 LLM 必选能力（无 client → 503），注入假 chat client 走真实分析路径。
    const server = buildApiServer({ bailianChatClient: createFakeChatClient() });

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

  // 真实性重构:无转写 client → 如实 503（此前返回 status:"degraded" 的占位稿冒充转写草稿,已剔除）。
  it("returns 503 for audio transcription when ASR is not configured", async () => {
    // Isolate from developer process.env keys — otherwise FromEnv creates a real client
    // and a failed upstream call returns 502 instead of the honest 503 not-configured path.
    const server = buildApiServer({
      env: {
        DASHSCOPE_API_KEY: "",
        BAILIAN_API_KEY: ""
      }
    });

    const response = await server.inject({
      method: "POST",
      url: "/api/corpus/transcriptions",
      payload: {
        title: "音频专访样本",
        sourceUrl: "https://example.com/interview-audio.mp3"
      }
    });

    expect(response.statusCode).toBe(503);
    expect(response.json().error).toContain("SenseVoice");
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

  it("persists local audio but 422s without CORPUS_AUDIO_PUBLIC_BASE_URL (no fake transcript)", async () => {
    // SenseVoice 只收公网 file_urls。未配置公开基址时：落盘 + 诚实 422，绝不调 ASR / 冒充转写。
    let asrCalled = false;
    const server = buildApiServer({
      bailianTranscriptionClient: {
        async transcribe() {
          asrCalled = true;
          throw new Error("ASR should never be called without a public base URL.");
        }
      }
    });

    const response = await server.inject({
      method: "POST",
      url: "/api/corpus/transcriptions",
      payload: {
        title: "本地音频专访样本",
        audioBase64: Buffer.from("fake-audio-bytes").toString("base64"),
        fileName: "interview.m4a"
      }
    });

    expect(asrCalled).toBe(false);
    expect(response.statusCode).toBe(422);
    const error = response.json().error as string;
    expect(error).toContain("interview.m4a");
    expect(error).toMatch(/CORPUS_AUDIO_PUBLIC_BASE_URL|公网/);
    expect(error).toContain("local-object://corpus-audio/");
  });

  it("maps local upload via CORPUS_AUDIO_PUBLIC_BASE_URL and calls SenseVoice", async () => {
    const seen: string[] = [];
    const server = buildApiServer({
      env: {
        CORPUS_AUDIO_PUBLIC_BASE_URL: "https://cdn.example.com",
        CORPUS_UPLOAD_DIR: ".data/test-corpus-audio"
      },
      bailianTranscriptionClient: {
        async transcribe(input) {
          seen.push(input.sourceUrl);
          return {
            providerId: "bailian-sensevoice",
            model: "sensevoice-v1",
            sourceUrl: input.sourceUrl,
            taskId: "task-local-1",
            transcriptionUrl: "https://transcription.example.com/local.json",
            durationSec: 12,
            text: "本地上传转写成功"
          };
        }
      }
    });

    const response = await server.inject({
      method: "POST",
      url: "/api/corpus/transcriptions",
      payload: {
        title: "本地可转写样本",
        audioBase64: Buffer.from("real-enough-audio").toString("base64"),
        fileName: "clip.wav",
        languageHint: "zh"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(seen[0]).toMatch(/^https:\/\/cdn\.example\.com\/api\/corpus\/audio-files\//);
    expect(response.json().transcription.text).toBe("本地上传转写成功");
    expect(response.json().localObjectUrl).toMatch(/^local-object:\/\/corpus-audio\//);
  });

  it("rejects an oversized locally uploaded audio file with a 422", async () => {
    const server = buildApiServer();
    // 26 MB of base64 payload — above the 25 MB guard.
    const oversized = "A".repeat(26 * 1024 * 1024);

    const response = await server.inject({
      method: "POST",
      url: "/api/corpus/transcriptions",
      payload: {
        title: "超大音频",
        audioBase64: oversized,
        fileName: "huge.wav"
      }
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error).toContain("25");
  });

  it("rejects a transcription request with neither a source URL nor an uploaded file", async () => {
    const server = buildApiServer();

    const response = await server.inject({
      method: "POST",
      url: "/api/corpus/transcriptions",
      payload: { title: "缺少来源" }
    });

    expect(response.statusCode).toBe(422);
  });

  it("runs an interview session through the Product API and persists the generated note", async () => {
    // 真实性重构:追问（/turns）与归档（/end 的记忆抽取+finalize+矛盾精判）均为 LLM 必选能力，
    // 注入全套假 client 走真实 LLM 代码路径（prompt 组装/解析/校验/落库全真）。
    const server = buildApiServer({
      bailianInterviewClient: createFakeInterviewClient(),
      bailianChatClient: createFakeChatClient(),
      embeddingClient: createFakeEmbeddingClient()
    });

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
    // intent 来自注入的假专访 client（createFakeInterviewClient 与真实 client 同契约的固定 intent）。
    expect(turnResponse.json().session.turns[1]).toMatchObject({
      role: "assistant",
      intent: "百炼角色扮演追问"
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

  // R7:删除"buildApiServer 默认工厂经 dbPath 落 SQLite 持久化"用例——该能力已随 sqlite 冷层删除。
  // 持久化(surreal 跨进程 reload)由 packages/db/src/surreal/surreal-product-state-repository.test.ts
  // 的重连往返用例覆盖(surrealkv 落盘 + 新连接读回)。

it("renders podcast audio through Bailian CosyVoice when the audio client is configured", async () => {
    // PO-P1-01: create defaults to script-only; TTS is explicit synthesize (or env opt-in).
    // 真实性重构:note 路径脚本由 LLM 生成（假 chat client 的 canned 播客脚本），TTS 收到的
    // 是 LLM 脚本而非确定性模板（"开场：今天我们回到"模板已剔除）。
    const previousAuto = process.env.PODCAST_AUTO_RENDER_ON_CREATE;
    delete process.env.PODCAST_AUTO_RENDER_ON_CREATE;
    const server = buildApiServer({
      bailianChatClient: createFakeChatClient(),
      bailianPodcastAudioClient: {
        async synthesize(input) {
          expect(input.text).toContain("播客脚本正文");
          // calm-host is normalized to verified CosyVoice preset longanyang
          expect(input.voice).toBe("longanyang");
          return {
            providerId: "bailian-cosyvoice",
            model: "cosyvoice-v3-plus",
            voice: "longanyang",
            audioUrl: "https://dashscope-result.example.com/podcast.mp3",
            expiresAt: 1791705600
          };
        }
      }
    });
    try {
      const stateResponse = await server.inject({ method: "GET", url: "/api/state" });
      const noteId = stateResponse.json().notes[0].id;

      const createResponse = await server.inject({
        method: "POST",
        url: "/api/podcast/episodes",
        payload: {
          noteId,
          format: "solo",
          voice: "calm-host"
        }
      });

      expect(createResponse.statusCode).toBe(200);
      const created = createResponse.json();
      expect(created.episode.noteId).toBe(noteId);
      expect(created.episode.script).toContain("播客脚本正文");
      // Default: no auto TTS on create
      expect(created.episode.audioUrl).not.toBe("https://dashscope-result.example.com/podcast.mp3");

      const synthResponse = await server.inject({
        method: "POST",
        url: `/api/podcast/episodes/${created.episode.id}/synthesize`
      });
      expect(synthResponse.statusCode).toBe(200);
      expect(synthResponse.json()).toMatchObject({
        episode: {
          noteId,
          voice: "longanyang",
          audioUrl: "https://dashscope-result.example.com/podcast.mp3"
        }
      });

      const persistedStateResponse = await server.inject({ method: "GET", url: "/api/state" });
      expect(persistedStateResponse.json().podcastEpisodes[0]).toMatchObject({
        noteId,
        voice: "longanyang",
        audioUrl: "https://dashscope-result.example.com/podcast.mp3"
      });
    } finally {
      if (previousAuto === undefined) delete process.env.PODCAST_AUTO_RENDER_ON_CREATE;
      else process.env.PODCAST_AUTO_RENDER_ON_CREATE = previousAuto;
    }
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

  describe("production-profile bearer auth (P0-5)", () => {
    it("blocks unauthenticated requests to /api/state when DEPLOYMENT_PROFILE=production and PRODUCT_API_TOKEN is set", async () => {
      const server = buildApiServer({
        env: { DEPLOYMENT_PROFILE: "production", PRODUCT_API_TOKEN: "secret" }
      });

      const response = await server.inject({ method: "GET", url: "/api/state" });

      expect(response.statusCode).toBe(401);
    });

    it("allows authenticated requests to /api/state with correct Bearer token in production profile", async () => {
      const server = buildApiServer({
        env: { DEPLOYMENT_PROFILE: "production", PRODUCT_API_TOKEN: "secret" }
      });

      const response = await server.inject({
        method: "GET",
        url: "/api/state",
        headers: { authorization: "Bearer secret" }
      });

      expect(response.statusCode).toBe(200);
    });

    it("rejects requests with wrong Bearer token in production profile", async () => {
      const server = buildApiServer({
        env: { DEPLOYMENT_PROFILE: "production", PRODUCT_API_TOKEN: "secret" }
      });

      const response = await server.inject({
        method: "GET",
        url: "/api/state",
        headers: { authorization: "Bearer wrong-token" }
      });

      expect(response.statusCode).toBe(401);
    });

    it("exempts /api/health from bearer auth in production profile (healthcheck use)", async () => {
      const server = buildApiServer({
        env: { DEPLOYMENT_PROFILE: "production", PRODUCT_API_TOKEN: "secret" }
      });

      const response = await server.inject({ method: "GET", url: "/api/health" });

      expect(response.statusCode).toBe(200);
    });

    it("runtime-bootstrap is auth-exempt, sets HttpOnly cookie without body secret; cookie authorizes /api/state", async () => {
      const server = buildApiServer({
        env: { DEPLOYMENT_PROFILE: "production", PRODUCT_API_TOKEN: "secret-bootstrap" }
      });

      // Unauthenticated bootstrap must succeed (SPA has no VITE bake-in yet).
      // inject() is HTTP — production must NOT set Secure or browsers drop the cookie.
      const boot = await server.inject({ method: "GET", url: "/api/runtime-bootstrap" });
      expect(boot.statusCode).toBe(200);
      const body = boot.json() as {
        authRequired: boolean;
        cookieSet: boolean;
        secureCookie?: boolean;
        token?: unknown;
      };
      expect(body.authRequired).toBe(true);
      expect(body.cookieSet).toBe(true);
      expect(body.secureCookie).toBe(false);
      // Long-lived secret must NOT appear in free JSON body.
      expect(body.token).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain("secret-bootstrap");
      const setCookie = boot.headers["set-cookie"];
      const cookieHeader = Array.isArray(setCookie) ? setCookie.join(";") : String(setCookie ?? "");
      expect(cookieHeader).toMatch(/product_api_token=/);
      expect(cookieHeader.toLowerCase()).toContain("httponly");
      expect(cookieHeader.toLowerCase()).not.toMatch(/(?:^|;\s*)secure(?:;|$)/);

      // Cookie alone authorizes subsequent API calls (HTTP production docker path).
      const viaCookie = await server.inject({
        method: "GET",
        url: "/api/state",
        headers: { cookie: "product_api_token=secret-bootstrap" }
      });
      expect(viaCookie.statusCode).toBe(200);

      // Query token path still works for WS/media when explicitly provisioned (not via bootstrap body).
      const viaQuery = await server.inject({
        method: "GET",
        url: "/api/state?token=secret-bootstrap"
      });
      expect(viaQuery.statusCode).toBe(200);
    });

    it("runtime-bootstrap sets Secure cookie only when request.protocol is https", async () => {
      const server = buildApiServer({
        env: { DEPLOYMENT_PROFILE: "production", PRODUCT_API_TOKEN: "secret-https" }
      });
      // Simulate TLS terminator: trustProxy + X-Forwarded-Proto → request.protocol === https
      const boot = await server.inject({
        method: "GET",
        url: "/api/runtime-bootstrap",
        headers: { "x-forwarded-proto": "https", host: "app.example.com" }
      });
      expect(boot.statusCode).toBe(200);
      const body = boot.json() as { secureCookie?: boolean };
      expect(body.secureCookie).toBe(true);
      const setCookie = boot.headers["set-cookie"];
      const cookieHeader = Array.isArray(setCookie) ? setCookie.join(";") : String(setCookie ?? "");
      expect(cookieHeader.toLowerCase()).toMatch(/(?:^|;\s*)secure(?:;|$)/);
      expect(JSON.stringify(boot.json())).not.toContain("secret-https");
    });

    it("CORS allows credentials for allowlisted Origin (cookie SPA model)", async () => {
      const server = buildApiServer({
        env: {
          DEPLOYMENT_PROFILE: "production",
          PRODUCT_API_TOKEN: "secret-cors",
          PRODUCT_WEB_ORIGINS: "http://127.0.0.1:3220"
        }
      });
      const res = await server.inject({
        method: "OPTIONS",
        url: "/api/state",
        headers: {
          origin: "http://127.0.0.1:3220",
          "access-control-request-method": "GET"
        }
      });
      expect(res.statusCode).toBe(204);
      expect(res.headers["access-control-allow-origin"]).toBe("http://127.0.0.1:3220");
      expect(res.headers["access-control-allow-credentials"]).toBe("true");
    });

    it("runtime-bootstrap reports authRequired=false when auth guard inactive (local)", async () => {
      const server = buildApiServer({ env: {} });
      const boot = await server.inject({ method: "GET", url: "/api/runtime-bootstrap" });
      expect(boot.statusCode).toBe(200);
      expect(boot.json()).toEqual({ authRequired: false, cookieSet: false });
    });

    it("does not enforce auth when DEPLOYMENT_PROFILE is not set (local zero-friction)", async () => {
      const server = buildApiServer({
        env: { PRODUCT_API_TOKEN: "secret" }
      });

      const response = await server.inject({ method: "GET", url: "/api/state" });

      expect(response.statusCode).toBe(200);
    });

    it("does not enforce auth when DEPLOYMENT_PROFILE is not 'production' (local zero-friction)", async () => {
      const server = buildApiServer({
        env: { DEPLOYMENT_PROFILE: "development", PRODUCT_API_TOKEN: "secret" }
      });

      const response = await server.inject({ method: "GET", url: "/api/state" });

      expect(response.statusCode).toBe(200);
    });

    it("does not enforce auth when PRODUCT_API_TOKEN is not set even in production profile", async () => {
      const server = buildApiServer({
        env: { DEPLOYMENT_PROFILE: "production" }
      });

      const response = await server.inject({ method: "GET", url: "/api/state" });

      expect(response.statusCode).toBe(200);
    });

    it("blocks unauthenticated requests when DEPLOYMENT_PROFILE='Production' (case-insensitive, security fix)", async () => {
      const server = buildApiServer({
        env: { DEPLOYMENT_PROFILE: "Production", PRODUCT_API_TOKEN: "secret" }
      });

      const response = await server.inject({ method: "GET", url: "/api/state" });

      expect(response.statusCode).toBe(401);
    });

    it("blocks unauthenticated requests when DEPLOYMENT_PROFILE='PRODUCTION' (case-insensitive, security fix)", async () => {
      const server = buildApiServer({
        env: { DEPLOYMENT_PROFILE: "PRODUCTION", PRODUCT_API_TOKEN: "secret" }
      });

      const response = await server.inject({ method: "GET", url: "/api/state" });

      expect(response.statusCode).toBe(401);
    });

    it("rejects a Bearer token that differs only by timing-exploitable length from correct token (security fix)", async () => {
      const server = buildApiServer({
        env: { DEPLOYMENT_PROFILE: "production", PRODUCT_API_TOKEN: "mysecret" }
      });

      // Wrong token of same length to exercise timing-safe path
      const response = await server.inject({
        method: "GET",
        url: "/api/state",
        headers: { authorization: "Bearer wrongsec" }
      });

      expect(response.statusCode).toBe(401);
    });
  });

  describe("CORS from PRODUCT_WEB_ORIGINS env (P1-3)", () => {
    it("reflects a configured origin in access-control-allow-origin when Origin matches", async () => {
      const server = buildApiServer({
        env: { PRODUCT_WEB_ORIGINS: "http://x.com" }
      });

      const response = await server.inject({
        method: "GET",
        url: "/api/health",
        headers: { origin: "http://x.com" }
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["access-control-allow-origin"]).toBe("http://x.com");
    });

    it("reflects multiple configured origins when any one matches", async () => {
      const server = buildApiServer({
        env: { PRODUCT_WEB_ORIGINS: "http://x.com,https://y.com" }
      });

      const responseX = await server.inject({
        method: "GET",
        url: "/api/health",
        headers: { origin: "http://x.com" }
      });
      const responseY = await server.inject({
        method: "GET",
        url: "/api/health",
        headers: { origin: "https://y.com" }
      });

      expect(responseX.headers["access-control-allow-origin"]).toBe("http://x.com");
      expect(responseY.headers["access-control-allow-origin"]).toBe("https://y.com");
    });

    it("does not set access-control-allow-origin for an origin not in PRODUCT_WEB_ORIGINS", async () => {
      const server = buildApiServer({
        env: { PRODUCT_WEB_ORIGINS: "http://x.com" }
      });

      const response = await server.inject({
        method: "GET",
        url: "/api/health",
        headers: { origin: "http://evil.com" }
      });

      expect(response.headers["access-control-allow-origin"]).not.toBe("http://evil.com");
    });

    it("still allows Vite dev origins when PRODUCT_WEB_ORIGINS is not set", async () => {
      const server = buildApiServer({ env: {} });

      const response = await server.inject({
        method: "GET",
        url: "/api/health",
        headers: { origin: "http://localhost:3220" }
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["access-control-allow-origin"]).toBe("http://localhost:3220");
    });

    it("handles preflight OPTIONS for a configured PRODUCT_WEB_ORIGINS origin", async () => {
      const server = buildApiServer({
        env: { PRODUCT_WEB_ORIGINS: "http://x.com" }
      });

      const response = await server.inject({
        method: "OPTIONS",
        url: "/api/health",
        headers: {
          origin: "http://x.com",
          "access-control-request-method": "GET"
        }
      });

      expect(response.statusCode).toBe(204);
      expect(response.headers["access-control-allow-origin"]).toBe("http://x.com");
    });
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
expect(response.json()).toMatchObject({ ok: true, ready: true, service: "interview-product-api" });
    });
  });
});

// N-10:优雅关闭序列——单测断言「close → flush → OTel → exit」顺序、数据 flush 优先于 OTel、
// 幂等(重复信号只跑一次)、flush 超时兜底仍退出并留信号、任一步抛错不阻断后续。真发信号难在
// 单测里做,故把序列抽成可注入依赖的 createGracefulShutdown,注入 fake exit(不杀测试进程)。
describe("createGracefulShutdown (N-10 优雅关闭序列)", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("顺序:closeServer → flushPersistence → shutdownTelemetry → exit(0)(数据 flush 先于 OTel)", async () => {
    const calls: string[] = [];
    const shutdown = createGracefulShutdown({
      closeServer: async () => { calls.push("close"); },
      flushPersistence: async () => { calls.push("flush"); },
      shutdownTelemetry: async () => { calls.push("otel"); },
      exit: (code) => { calls.push(`exit:${code}`); }
    });
    await shutdown("SIGTERM");
    expect(calls).toEqual(["close", "flush", "otel", "exit:0"]);
  });

  it("幂等:重复信号只跑一次(close/flush/exit 各恰一次)", async () => {
    let close = 0, flush = 0, exit = 0;
    const shutdown = createGracefulShutdown({
      closeServer: async () => { close += 1; },
      flushPersistence: async () => { flush += 1; },
      shutdownTelemetry: async () => {},
      exit: () => { exit += 1; }
    });
    await shutdown("SIGINT");
    await shutdown("SIGTERM");   // 第二个信号:被 shuttingDown 守卫挡住
    expect(close).toBe(1);
    expect(flush).toBe(1);
    expect(exit).toBe(1);
  });

  it("flush 卡住 → 超时兜底仍走到 exit(不永久挂起),并记「可能丢失未落库写」(呼应 N-02)", async () => {
    let exited = false;
    const shutdown = createGracefulShutdown({
      closeServer: async () => {},
      flushPersistence: () => new Promise<void>(() => {}),   // 永不 resolve
      shutdownTelemetry: async () => {},
      exit: () => { exited = true; },
      flushTimeoutMs: 20
    });
    await shutdown("SIGTERM");
    expect(exited).toBe(true);
    expect(errorSpy.mock.calls.some((c: unknown[]) => String(c[0]).includes("graceful_shutdown_flush_failed"))).toBe(true);
  });

  it("closeServer 抛错不阻断后续步骤(仍 flush + exit)", async () => {
    const calls: string[] = [];
    const shutdown = createGracefulShutdown({
      closeServer: async () => { throw new Error("close boom"); },
      flushPersistence: async () => { calls.push("flush"); },
      shutdownTelemetry: async () => {},
      exit: () => { calls.push("exit"); }
    });
    await shutdown("SIGTERM");
    expect(calls).toEqual(["flush", "exit"]);
  });

  it("flush 抛错(非超时)不阻断退出,仍关 OTel + exit", async () => {
    const calls: string[] = [];
    const shutdown = createGracefulShutdown({
      closeServer: async () => { calls.push("close"); },
      flushPersistence: async () => { throw new Error("flush boom"); },
      shutdownTelemetry: async () => { calls.push("otel"); },
      exit: () => { calls.push("exit"); }
    });
    await shutdown("SIGTERM");
    expect(calls).toEqual(["close", "otel", "exit"]);
  });
});
