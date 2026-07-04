import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { buildApiServer } from "../server";
import { createInMemoryProductStateRepository } from "../product-state-repository";
import { createInitialProductState } from "../../../../src/domain/engine";
import type { RagChunk, ImportSource } from "../../../../src/domain/types";
import { createLlmBudget } from "../llm-budget";
import { registerRagRoutes } from "./rag";

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
    const fakeAnswer = "AI在产品设计中扮演重要角色。";
    const fakeChatClient = {
      complete: async () => fakeAnswer
    };

    const server = buildApiServer({
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
    expect(body.citations.length).toBeGreaterThan(0);
    expect(body.citations[0].id).toBe(chunkId);
    expect(body.citations[0].title).toBe("AI 产品分析");

    await server.close();
  });

  it("离线路径: 无 embeddingClient/chatClient → 200, 关键词召回 + 确定性 fallback 答案", async () => {
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
      productStateRepository: repository
      // no embeddingClient, no bailianChatClient
    });

    const res = await server.inject({
      method: "POST",
      url: "/api/rag/query",
      payload: { question: "产品战略" }
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.answer).toBe("string");
    expect(body.answer.length).toBeGreaterThan(0);
    // fallback answer should not be the "no data" message since we have matching chunks
    expect(body.answer).not.toContain("暂无相关资料");
    expect(Array.isArray(body.citations)).toBe(true);
    // should have at least one citation from keyword match
    expect(body.citations.length).toBeGreaterThan(0);

    await server.close();
  });

  it("预算耗尽: chatClient 不被调用，走 fallback，citations 仅含 fallback 实际引用的 chunk", async () => {
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

    expect(res.statusCode).toBe(200);
    const body = res.json();
    // 预算耗尽 → chatClient 一次都不应被调用
    expect(chatCallCount).toBe(0);
    // 走 fallback 路径：answer 有内容且不是通用错误
    expect(typeof body.answer).toBe("string");
    expect(body.answer).not.toContain("暂无相关资料");
    // citations 仅含 fallback 实际引用的 chunk（≤3），不超出
    expect(Array.isArray(body.citations)).toBe(true);
    expect(body.citations.length).toBeGreaterThan(0);
    // 所有 citations 的 id 都应在实际 chunk 列表内
    const validIds = new Set([chunkId]);
    body.citations.forEach((c: { id: string }) => {
      expect(validIds.has(c.id)).toBe(true);
    });

    await server.close();
  });

  it("边界: 无任何 ragChunks → 200, answer 提示暂无资料, citations 空", async () => {
    const initialState = {
      ...createInitialProductState(),
      ragChunks: [],
      importSources: []
    };
    const repository = createInMemoryProductStateRepository(initialState);

    const server = buildApiServer({ productStateRepository: repository });

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
    const server = buildApiServer({});
    const res = await server.inject({
      method: "POST",
      url: "/api/rag/query",
      payload: {}
    });
    expect(res.statusCode).toBe(422);
    await server.close();
  });

  // ── 修复5: citations 与答案实际引用 chunk 集合一致 ────────────────────────
  it("离线 fallback: citations 仅含答案实际引用的前 3 个 chunk，不超出", async () => {
    // 准备 5 个 chunks，关键词都匹配 → top-k 全部召回
    const chunks = Array.from({ length: 5 }, (_, i) => {
      const id = `chunk-align-${i}`;
      const sourceId = `src-align-${i}`;
      return {
        chunk: makeChunk({
          id,
          sourceId,
          title: `资料${i + 1}`,
          text: `产品战略内容${i + 1}，这是战略文本。`,
          keywords: ["产品", "战略"]
        }),
        source: makeSource(sourceId)
      };
    });

    const initialState = {
      ...createInitialProductState(),
      ragChunks: chunks.map((x) => x.chunk),
      importSources: chunks.map((x) => x.source)
    };
    const repository = createInMemoryProductStateRepository(initialState);

    // 无 embeddingClient / chatClient → 走离线 fallback
    const server = Fastify();
    await registerRagRoutes(server, repository, {});

    const res = await server.inject({
      method: "POST",
      url: "/api/rag/query",
      payload: { question: "产品战略" }
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    // fallback 答案使用前 3 chunk，citations 应 ≤ 3（而非全部 5 个）
    expect(body.citations.length).toBeLessThanOrEqual(3);
    // answer 中引用的资料标题与 citations 一一对应
    body.citations.forEach((citation: { id: string; title: string }) => {
      expect(body.answer).toContain(citation.title);
    });

    await server.close();
  });

  it("在线路径: citations 与 LLM 实际用于生成答案的所有 chunk 对齐（含全部 top-k）", async () => {
    // 3 个 chunks，embedding 完全匹配 → 全部进入 top-k
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
      complete: async () => "AI 内容综合回答"
    };

    const server = buildApiServer({
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
    // 在线路径: LLM 使用全部召回 chunk，citations 应含 3 个
    expect(body.citations).toHaveLength(3);
    const citationIds = body.citations.map((c: { id: string }) => c.id);
    sources.forEach(({ chunk }) => {
      expect(citationIds).toContain(chunk.id);
    });

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
    await registerRagRoutes(server, repository, {}); // 无 LLM → 确定性 fallback,citations 与召回严格对齐
    const res = await server.inject({ method: "POST", url: "/api/rag/query", payload: { question: "AI 产品" } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // 原生命中 chunk-b;若走域层关键词路径则会是 chunk-a → 证明原生路径真被优先采用
    expect(body.citations.map((c: { id: string }) => c.id)).toEqual(["chunk-b"]);
    await server.close();
  });

  it("方案一 fail-safe: 原生召回抛错 → 回落域层排序,仍 200 且召回关键词命中", async () => {
    const { state } = nativeRecallState();
    const repository = withNativeRecall(createInMemoryProductStateRepository(state), async () => {
      throw new Error("native boom");
    });
    const server = Fastify();
    await registerRagRoutes(server, repository, {});
    const res = await server.inject({ method: "POST", url: "/api/rag/query", payload: { question: "AI 产品" } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.citations.map((c: { id: string }) => c.id)).toContain("chunk-a"); // 域层关键词路径兜底
    await server.close();
  });

  it("方案一 fail-safe: 原生命中全被域层门控滤掉(usage 不符)→ 回落域层排序", async () => {
    const { state } = nativeRecallState();
    // 把 chunk-b 改成 memory-candidate:原生桩仍返回它,但域层重验 usage 后为空 → 回落。
    const gated = {
      ...state,
      ragChunks: state.ragChunks.map((c) => (c.id === "chunk-b" ? { ...c, usage: "memory-candidate" as const } : c))
    };
    const repository = withNativeRecall(createInMemoryProductStateRepository(gated), async () => [
      { id: "chunk-b", text: "完全无关的内容片段。" }
    ]);
    const server = Fastify();
    await registerRagRoutes(server, repository, {});
    const res = await server.inject({ method: "POST", url: "/api/rag/query", payload: { question: "AI 产品" } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.citations.map((c: { id: string }) => c.id)).toContain("chunk-a"); // 门控滤空 → 域层兜底
    await server.close();
  });
});
