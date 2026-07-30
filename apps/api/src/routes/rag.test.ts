import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { buildApiServer } from "../server";
import { createInMemoryProductStateRepository } from "../product-state-repository";
import { createInitialProductState } from "../../../../src/domain/engine";
import type { RagChunk, ImportSource } from "../../../../src/domain/types";
import { createLlmBudget } from "../llm-budget";
import { registerRagRoutes } from "./rag";
import { createFakeChatClient } from "../test-helpers/fake-llm-clients";

// ---------- helpers ----------

function makeChunk(overrides: Partial<RagChunk> & { id: string; sourceId: string }): RagChunk {
  return {
    title: "测试资料",
    text: "这是一段测试内容，包含关键词AI和产品。",
    keywords: ["ai", "产品"],
    tokenEstimate: 20,
    usage: "interview-context",
    createdAt: new Date().toISOString(),
    ...overrides
  };
}

function makeSource(id: string): ImportSource {
  return {
    id,
    title: "测试来源",
    content: "内容",
    sourceType: "text",
    status: "chunked",
    sensitivity: "normal",
    chunkIds: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

// A tiny 3-dim embedding — enough to verify cosine path is taken.
const QUERY_VEC = [1, 0, 0];
const CHUNK_VEC = [1, 0, 0]; // cosine = 1.0 (perfect match)

// ---------- tests ----------

describe("POST /api/rag/query", () => {
  it("在线路径: embeddingClient + chatClient → 200, answer + citations", async () => {
    const sourceId = "src-1";
    const chunkId = "chunk-1";

    const chunk = makeChunk({
      id: chunkId,
      sourceId,
      title: "AI 产品分析",
      text: "这篇文章讨论了AI在产品设计中的应用。",
      keywords: ["ai", "产品"],
      embedding: CHUNK_VEC
    });
    const source = makeSource(sourceId);

    const initialState = {
      ...createInitialProductState(),
      ragChunks: [chunk],
      importSources: [source]
    };
    const repository = createInMemoryProductStateRepository(initialState);

    const fakeEmbeddingClient = {
      embed: async (_texts: string[]) => [QUERY_VEC]
    };
    // Model must mark used sources as [n] — same contract as /api/chat (C-P2-03).
    const fakeAnswer = "AI在产品设计中扮演重要角色[1]。";
    const fakeChatClient = {
      complete: async () => fakeAnswer
    };

    const server = buildApiServer({
      env: { DASHSCOPE_API_KEY: "", BAILIAN_API_KEY: "" },
      productStateRepository: repository,
      embeddingClient: fakeEmbeddingClient as never,
      bailianChatClient: fakeChatClient as never
    });

    const res = await server.inject({
      method: "POST",
      url: "/api/rag/query",
      payload: { question: "AI产品设计" }
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.answer).toBe(fakeAnswer);
    expect(Array.isArray(body.citations)).toBe(true);
    expect(body.citations.length).toBe(1);
    expect(body.citations[0].id).toBe(chunkId);
    expect(body.citations[0].title).toBe("AI 产品分析");
    expect(body.citations[0].citationIndex).toBe(1);

    await server.close();
  });

  // 真实性重构：buildFallbackAnswer 拼接答案已删除——无 chatClient 即"问答不可用"，如实 503。
  it("无 chatClient → 503（有资料也不做召回白工，不再用拼接片段冒充答案）", async () => {
    const sourceId = "src-2";
    const chunkId = "chunk-2";

    const chunk = makeChunk({
      id: chunkId,
      sourceId,
      title: "产品战略",
      text: "产品战略需要考虑市场定位和用户需求。",
      keywords: ["产品", "战略", "用户"]
      // no embedding
    });
    const source = makeSource(sourceId);

    const initialState = {
      ...createInitialProductState(),
      ragChunks: [chunk],
      importSources: [source]
    };
    const repository = createInMemoryProductStateRepository(initialState);

    const server = buildApiServer({
      env: { DASHSCOPE_API_KEY: "", BAILIAN_API_KEY: "" },
      productStateRepository: repository
      // no embeddingClient, no bailianChatClient
    });

    const res = await server.inject({
      method: "POST",
      url: "/api/rag/query",
      payload: { question: "产品战略" }
    });

    expect(res.statusCode).toBe(503);
    expect(res.json().error).toContain("未配置");

    await server.close();
  });

  // 真实性重构：预算耗尽不再走 fallback 拼接——如实 429，chatClient 一次不被调用。
  it("预算耗尽 → 429，chatClient 不被调用", async () => {
    const sourceId = "src-3";
    const chunkId = "chunk-3";

    const chunk = makeChunk({
      id: chunkId,
      sourceId,
      title: "AI趋势",
      text: "AI发展趋势不断加速，大模型应用广泛。",
      keywords: ["ai", "大模型"],
      embedding: CHUNK_VEC
    });
    const source = makeSource(sourceId);

    const initialState = {
      ...createInitialProductState(),
      ragChunks: [chunk],
      importSources: [source]
    };
    const repository = createInMemoryProductStateRepository(initialState);

    // 真实注入预算耗尽: maxCallsPerSession=1，先消耗掉唯一的配额
    // createLlmBudget({ maxCallsPerSession: 0 }) 会回落到默认 200，因此用 1 再消耗
    const exhaustedBudget = createLlmBudget({ maxCallsPerSession: 1 });
    exhaustedBudget.tryConsume("rag_query"); // 消耗唯一配额 → 之后 tryConsume 返回 false

    const fakeEmbeddingClient = {
      embed: async (_texts: string[]) => [QUERY_VEC]
    };
    let chatCallCount = 0;
    const fakeChatClient = {
      complete: async () => { chatCallCount++; return "这不应该被调用"; }
    };

    // 直接使用 registerRagRoutes 注入 exhaustedBudget，绕过 buildApiServer 不支持传 budget 的限制
    const server = Fastify();
    await registerRagRoutes(server, repository, {
      embeddingClient: fakeEmbeddingClient as never,
      bailianChatClient: fakeChatClient as never,
      llmBudget: exhaustedBudget
    });

    const res = await server.inject({
      method: "POST",
      url: "/api/rag/query",
      payload: { question: "AI大模型" }
    });

    expect(res.statusCode).toBe(429);
    expect(res.json().error).toContain("预算已用尽");
    // 预算耗尽 → chatClient 一次都不应被调用
    expect(chatCallCount).toBe(0);

    await server.close();
  });

  it("边界: 无任何 ragChunks → 200, answer 提示暂无资料, citations 空", async () => {
    const initialState = {
      ...createInitialProductState(),
      ragChunks: [],
      importSources: []
    };
    const repository = createInMemoryProductStateRepository(initialState);

    const server = buildApiServer({
      env: { DASHSCOPE_API_KEY: "", BAILIAN_API_KEY: "" }, productStateRepository: repository });

    const res = await server.inject({
      method: "POST",
      url: "/api/rag/query",
      payload: { question: "任何问题" }
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.answer).toContain("暂无相关资料");
    expect(body.citations).toEqual([]);

    await server.close();
  });

  it("缺少 question 字段 → 422", async () => {
    const server = buildApiServer({
      env: { DASHSCOPE_API_KEY: "", BAILIAN_API_KEY: "" },});
    const res = await server.inject({
      method: "POST",
      url: "/api/rag/query",
      payload: {}
    });
    expect(res.statusCode).toBe(422);
    await server.close();
  });

  // （已剔除）"离线 fallback: citations 仅含答案实际引用的前 3 个 chunk"——buildFallbackAnswer
  // 拼接答案已随真实性重构删除，无 chatClient 即 503；citations 与召回集合的对齐由下方在线用例钉住。

  it("C-P2-03: citations only include chunks the model marked with [n] (not full top-k)", async () => {
    // 3 个 chunks，embedding 完全匹配 → 全部进入 top-k 召回；但答案只标 [1][3]
    const sources = Array.from({ length: 3 }, (_, i) => {
      const id = `chunk-online-${i}`;
      const srcId = `src-online-${i}`;
      return {
        chunk: makeChunk({
          id,
          sourceId: srcId,
          title: `在线资料${i + 1}`,
          text: `AI内容${i + 1}`,
          keywords: ["ai"],
          embedding: CHUNK_VEC
        }),
        source: makeSource(srcId)
      };
    });

    const initialState = {
      ...createInitialProductState(),
      ragChunks: sources.map((x) => x.chunk),
      importSources: sources.map((x) => x.source)
    };
    const repository = createInMemoryProductStateRepository(initialState);

    const fakeEmbeddingClient = {
      embed: async (_texts: string[]) => [QUERY_VEC]
    };
    const fakeChatClient = {
      complete: async () => "综合 [1] 与 [3] 的观点，第二份未直接使用。"
    };

    const server = buildApiServer({
      env: { DASHSCOPE_API_KEY: "", BAILIAN_API_KEY: "" },
      productStateRepository: repository,
      embeddingClient: fakeEmbeddingClient as never,
      bailianChatClient: fakeChatClient as never
    });

    const res = await server.inject({
      method: "POST",
      url: "/api/rag/query",
      payload: { question: "AI" }
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.citations).toHaveLength(2);
    expect(body.citations.map((c: { id: string }) => c.id)).toEqual([
      sources[0]!.chunk.id,
      sources[2]!.chunk.id
    ]);
    expect(body.citations.map((c: { citationIndex: number }) => c.citationIndex)).toEqual([1, 3]);

    await server.close();
  });

  it("C-P2-03: answer without [n] markers → empty citations (no silent top-k dump)", async () => {
    const chunk = makeChunk({
      id: "chunk-no-cite",
      sourceId: "src-no-cite",
      title: "未标注资料",
      text: "AI 内容",
      keywords: ["ai"],
      embedding: CHUNK_VEC
    });
    const repository = createInMemoryProductStateRepository({
      ...createInitialProductState(),
      ragChunks: [chunk],
      importSources: [makeSource("src-no-cite")]
    });
    const server = buildApiServer({
      env: { DASHSCOPE_API_KEY: "", BAILIAN_API_KEY: "" },
      productStateRepository: repository,
      embeddingClient: { embed: async () => [QUERY_VEC] } as never,
      bailianChatClient: { complete: async () => "没有任何编号的回答" } as never
    });
    const res = await server.inject({
      method: "POST",
      url: "/api/rag/query",
      payload: { question: "AI" }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().citations).toEqual([]);
    await server.close();
  });

  // ── 方案一: surreal 权威档位的原生混合检索接线 ────────────────────────
  function nativeRecallState() {
    // chunk-a: 关键词与问题强匹配 → 域层排序路径必召回它(用于区分两条路径)。
    // chunk-b: 文本与问题无关 → 域层路径召不回,只有原生命中才会出现。
    const chunkA = makeChunk({ id: "chunk-a", sourceId: "src-n", title: "关键词资料", text: "AI 产品设计的应用与AI产品实践。", keywords: ["ai", "产品"] });
    const chunkB = makeChunk({ id: "chunk-b", sourceId: "src-n", title: "原生命中资料", text: "完全无关的内容片段。", keywords: [] });
    return {
      state: { ...createInitialProductState(), ragChunks: [chunkA, chunkB], importSources: [makeSource("src-n")] },
      chunkA, chunkB
    };
  }
  /** 结构等价 SurrealRepoHandle 的三件套 + recallRagChunks(测试桩)。 */
  function withNativeRecall<T extends object>(repo: T, recallRagChunks: () => Promise<Array<{ id: string; text: string }>>) {
    return Object.assign(repo, {
      recallThemeAssets: async () => ({ points: [], decisions: [], questions: [], memories: [] }),
      recallMemoriesByVector: async () => [] as Array<{ id: string; text: string }>,
      recallProvenanceTurns: async () => [] as Array<{ id: string; content: string; sessionId: string; role: string }>,
      recallRagChunks
    });
  }

  it("方案一: repo 具备原生 recallRagChunks → 原生命中优先于域层排序(域层重验门控后)", async () => {
    const { state } = nativeRecallState();
    const repository = withNativeRecall(createInMemoryProductStateRepository(state), async () => [
      { id: "chunk-b", text: "完全无关的内容片段。" }
    ]);
    const server = Fastify();
    // 真实性重构:答案生成是必选 LLM 能力——注入确定性假 client 走真实生成路径。
    await registerRagRoutes(server, repository, { bailianChatClient: createFakeChatClient() });
    const res = await server.inject({ method: "POST", url: "/api/rag/query", payload: { question: "AI 产品" } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // 原生命中 chunk-b;若走域层关键词路径则会是 chunk-a → 证明原生路径真被优先采用
    expect(body.citations.map((c: { id: string }) => c.id)).toEqual(["chunk-b"]);
    expect(typeof body.answer).toBe("string");
    expect(body.answer.length).toBeGreaterThan(0);
    await server.close();
  });

  // 真实性重构:原生召回抛错不再回落域层排序掩盖差异——如实 502。
  it("原生召回抛错 → 502（不再静默回落域层排序）", async () => {
    const { state } = nativeRecallState();
    const repository = withNativeRecall(createInMemoryProductStateRepository(state), async () => {
      throw new Error("native boom");
    });
    const server = Fastify();
    await registerRagRoutes(server, repository, { bailianChatClient: createFakeChatClient() });
    const res = await server.inject({ method: "POST", url: "/api/rag/query", payload: { question: "AI 产品" } });
    expect(res.statusCode).toBe(502);
    const body = res.json();
    expect(body.error).toContain("资料召回失败");
    expect(body.error).toContain("native boom");
    await server.close();
  });

  // 真实性重构:原生命中被域层门控全滤 = 没有相关资料（诚实的空），不再回落域层排序。
  it("原生命中全被域层门控滤掉(usage 不符)→ 200 诚实的空（不回落域层排序）", async () => {
    const { state } = nativeRecallState();
    // 把 chunk-b 改成 memory-candidate:原生桩仍返回它,但域层重验 usage 后为空。
    const gated = {
      ...state,
      ragChunks: state.ragChunks.map((c) => (c.id === "chunk-b" ? { ...c, usage: "memory-candidate" as const } : c))
    };
    const repository = withNativeRecall(createInMemoryProductStateRepository(gated), async () => [
      { id: "chunk-b", text: "完全无关的内容片段。" }
    ]);
    const server = Fastify();
    await registerRagRoutes(server, repository, { bailianChatClient: createFakeChatClient() });
    const res = await server.inject({ method: "POST", url: "/api/rag/query", payload: { question: "AI 产品" } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.answer).toContain("暂无相关资料");
    expect(body.citations).toEqual([]);
    await server.close();
  });
});
