import { describe, expect, it } from "vitest";
import { buildApiServer } from "../server";
import { createInMemoryProductStateRepository } from "../product-state-repository";
import { createInMemoryKnowledgeIndexRepository, type KnowledgeIndexRepository } from "../knowledge-index-repository";
import { createInitialProductState } from "../../../../src/domain/engine";
import type { KnowledgeChunk } from "../../../../src/domain/types";

function makeChunk(overrides: Partial<KnowledgeChunk> & { id: string }): KnowledgeChunk {
  return {
    sourceType: "memory",
    sourceId: overrides.id,
    title: "担忧记录",
    text: "我担心放权之后团队失控。",
    keywords: ["担心", "放权", "失控"],
    createdAt: new Date().toISOString(),
    ...overrides
  };
}

// R2a:仓库接口已异步化,await put。
async function seedKnowledge() {
  const repo = createInMemoryKnowledgeIndexRepository();
  await repo.put(makeChunk({ id: "k1", title: "担忧记录", text: "我担心放权之后团队失控。", keywords: ["担心", "放权", "失控"] }));
  await repo.put(makeChunk({ id: "k2", title: "天气", text: "今天天气不错。", keywords: ["天气"] }));
  return repo;
}

describe("POST /api/chat", () => {
  it("在线: 新建会话, user+assistant 两条消息, assistant.citations 非空", async () => {
    const repository = createInMemoryProductStateRepository(createInitialProductState());
    const knowledgeIndexRepository = await seedKnowledge();
    const fakeChatClient = { complete: async () => "根据你的资料[1],你担心放权失控。" };

    const server = buildApiServer({
      env: { DASHSCOPE_API_KEY: "", BAILIAN_API_KEY: "" },
      productStateRepository: repository,
      knowledgeIndexRepository,
      bailianChatClient: fakeChatClient as never
    });

    const res = await server.inject({
      method: "POST",
      url: "/api/chat",
      payload: { message: "我担心什么?" }
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.sessionId).toBe("string");
    expect(body.answer).toContain("放权");
    expect(Array.isArray(body.citations)).toBe(true);
    expect(body.citations.length).toBeGreaterThan(0);

    const session = body.state.chatSessions.find((s: any) => s.id === body.sessionId);
    expect(session).toBeDefined();
    expect(session.messages).toHaveLength(2);
    expect(session.messages[0].role).toBe("user");
    expect(session.messages[1].role).toBe("assistant");
    expect(session.messages[1].citations.length).toBeGreaterThan(0);
    expect(session.title).toBe("我担心什么?");
    expect(session.messages[1].groundingMode).toBe("grounded");
    expect(body.groundingMode).toBe("grounded");

    await server.close();
  });

  it("同会话追加: 第二次带 sessionId → messages 变 4 条", async () => {
    const repository = createInMemoryProductStateRepository(createInitialProductState());
    const knowledgeIndexRepository = await seedKnowledge();
    let callCount = 0;
    const fakeChatClient = {
      complete: async () => {
        callCount += 1;
        return callCount === 1 ? "根据你的资料[1]..." : "我没有检索到更多相关资料。";
      }
    };

    const server = buildApiServer({
      env: { DASHSCOPE_API_KEY: "", BAILIAN_API_KEY: "" },
      productStateRepository: repository,
      knowledgeIndexRepository,
      bailianChatClient: fakeChatClient as never
    });

    const first = await server.inject({
      method: "POST",
      url: "/api/chat",
      payload: { message: "我担心什么?" }
    });
    const { sessionId } = first.json();

    const second = await server.inject({
      method: "POST",
      url: "/api/chat",
      payload: { sessionId, message: "还有呢?" }
    });

    expect(second.statusCode).toBe(200);
    const body = second.json();
    expect(body.sessionId).toBe(sessionId);
    const session = body.state.chatSessions.find((s: any) => s.id === sessionId);
    expect(session.messages).toHaveLength(4);

    await server.close();
  });

  it("message 空 → 422", async () => {
    const repository = createInMemoryProductStateRepository(createInitialProductState());
    const knowledgeIndexRepository = await seedKnowledge();
    const fakeChatClient = { complete: async () => "x" };

    const server = buildApiServer({
      env: { DASHSCOPE_API_KEY: "", BAILIAN_API_KEY: "" },
      productStateRepository: repository,
      knowledgeIndexRepository,
      bailianChatClient: fakeChatClient as never
    });

    const res = await server.inject({
      method: "POST",
      url: "/api/chat",
      payload: { message: "   " }
    });

    expect(res.statusCode).toBe(422);
    await server.close();
  });

  // ── R2c · 原生混合召回注入矩阵:有 searchHybrid(surreal 档)/ 无(sqlite/in-memory 档,上方
  //    既有用例已覆盖)两种注入下路由都工作,响应契约(state/sessionId/answer/citations)一致。 ──

  /** 在 in-memory repo 上叠加 searchHybrid 能力 + listAll 调用计数(断言新旧路径的选择)。 */
  async function seedHybridKnowledge(behavior: {
    hybrid: (q: { text: string; embedding?: number[]; limit: number }) => Promise<KnowledgeChunk[]>;
  }) {
    const inner = await seedKnowledge();
    const hybridCalls: Array<{ text: string; embedding?: number[]; limit: number }> = [];
    let listAllCalls = 0;
    const repo: KnowledgeIndexRepository = {
      ...inner,
      listAll: async () => { listAllCalls += 1; return inner.listAll(); },
      searchHybrid: async (q) => { hybridCalls.push(q); return behavior.hybrid(q); }
    };
    return { repo, hybridCalls, listAllCalls: () => listAllCalls };
  }

  it("R2c 有 searchHybrid: 原生候选集 + 域层精排, 不再 listAll 全表; 响应契约不变", async () => {
    const repository = createInMemoryProductStateRepository(createInitialProductState());
    // 原生路返回带 embedding 的候选块(query embedding 同向 → 精排 cosine=1 必进前 TOP_K)。
    const { repo, hybridCalls, listAllCalls } = await seedHybridKnowledge({
      hybrid: async () => [makeChunk({ id: "k1", embedding: [1, 0, 0] })]
    });
    const fakeChatClient = { complete: async () => "根据你的资料[1],你担心放权失控。" };
    const fakeEmbedding = { providerId: "fake", embed: async (texts: string[]) => texts.map(() => [1, 0, 0]) };

    const server = buildApiServer({
      env: { DASHSCOPE_API_KEY: "", BAILIAN_API_KEY: "" },
      productStateRepository: repository,
      knowledgeIndexRepository: repo,
      bailianChatClient: fakeChatClient as never,
      embeddingClient: fakeEmbedding as never
    });

    const res = await server.inject({ method: "POST", url: "/api/chat", payload: { message: "我担心什么?" } });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    // 消费形状:searchHybrid 收到 message 原文、query 向量、放大后的候选上限(TOP_K=8 × 3)。
    expect(hybridCalls).toHaveLength(1);
    expect(hybridCalls[0].text).toBe("我担心什么?");
    expect(hybridCalls[0].embedding).toEqual([1, 0, 0]);
    expect(hybridCalls[0].limit).toBe(24);
    // 原生路命中即为候选来源:不再走 listAll 全表(P6 双份真相的消费侧收敛)。
    expect(listAllCalls()).toBe(0);
    // 响应契约与旧路径一致:citations 指向候选块。
    expect(typeof body.sessionId).toBe("string");
    expect(body.citations.length).toBeGreaterThan(0);
    expect(body.citations[0].sourceId).toBe("k1");
    const session = body.state.chatSessions.find((s: any) => s.id === body.sessionId);
    expect(session.messages).toHaveLength(2);
    expect(session.messages[1].role).toBe("assistant");

    await server.close();
  });

  // 真实性重构:原生召回抛错不再静默换路(listAll 回落已删)——如实 502,本轮消息不入库。
  it("searchHybrid 抛错 → 502（不再回落 listAll，本轮消息不入库）", async () => {
    const repository = createInMemoryProductStateRepository(createInitialProductState());
    const { repo, listAllCalls } = await seedHybridKnowledge({
      hybrid: async () => { throw new Error("simulated native recall failure"); }
    });
    const fakeChatClient = { complete: async () => "根据你的资料[1],你担心放权失控。" };

    const server = buildApiServer({
      env: { DASHSCOPE_API_KEY: "", BAILIAN_API_KEY: "" },
      productStateRepository: repository,
      knowledgeIndexRepository: repo,
      bailianChatClient: fakeChatClient as never
    });

    const res = await server.inject({ method: "POST", url: "/api/chat", payload: { message: "我担心什么?" } });

    expect(res.statusCode).toBe(502);
    const body = res.json();
    expect(body.error).toContain("对话资料召回失败");
    expect(listAllCalls()).toBe(0);   // 绝不静默换路
    // 原子失败:本轮 user 消息未持久化
    expect(repository.getState().chatSessions).toHaveLength(0);

    await server.close();
  });

  // 真实性重构:空候选=没有相关资料(诚实的空),不再回落 listAll 全表掩盖差异——照常生成、不带引用。
  it("searchHybrid 返回空候选 → 200 诚实空检索（不回落 listAll，citations 空）", async () => {
    const repository = createInMemoryProductStateRepository(createInitialProductState());
    const { repo, hybridCalls, listAllCalls } = await seedHybridKnowledge({ hybrid: async () => [] });
    const fakeChatClient = { complete: async () => "我没有检索到相关资料，仅凭对话历史回答。" };

    const server = buildApiServer({
      env: { DASHSCOPE_API_KEY: "", BAILIAN_API_KEY: "" },
      productStateRepository: repository,
      knowledgeIndexRepository: repo,
      bailianChatClient: fakeChatClient as never
    });

    const res = await server.inject({ method: "POST", url: "/api/chat", payload: { message: "我担心什么?" } });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(hybridCalls).toHaveLength(1);
    // 无 embeddingClient → query 向量缺席:消费点须以"不带 embedding 键"调用(BM25-only 语义),
    // 而不是传 undefined/空数组。
    expect(hybridCalls[0].embedding).toBeUndefined();
    expect(listAllCalls()).toBe(0);   // 空候选不再回落全表
    expect(body.citations).toHaveLength(0);   // 诚实的空:回答不带引用
    const session = body.state.chatSessions.find((s: any) => s.id === body.sessionId);
    expect(session.messages).toHaveLength(2);   // 正常生成照常入库
    expect(session.messages[1].role).toBe("assistant");

    await server.close();
  });

  // 真实性重构:精排全零同样是诚实的空——不再回落 listAll,无关候选块绝不进引用。
  it("候选非空但域层精排全零 → 200 诚实空检索（不回落 listAll）", async () => {
    const repository = createInMemoryProductStateRepository(createInitialProductState());
    // 原生路返回与 query 向量正交的候选块(cosine=0)且关键词零重叠 → rankKnowledgeChunks 的
    // score>0 闸门全滤 → 精排结果为空。
    const { repo, hybridCalls, listAllCalls } = await seedHybridKnowledge({
      hybrid: async () => [makeChunk({ id: "irrelevant", text: "火星地貌研究笔记。", keywords: ["火星"], embedding: [0, 1, 0] })]
    });
    const fakeChatClient = { complete: async () => "我没有检索到相关资料，仅凭对话历史回答。" };
    const fakeEmbedding = { providerId: "fake", embed: async (texts: string[]) => texts.map(() => [1, 0, 0]) };

    const server = buildApiServer({
      env: { DASHSCOPE_API_KEY: "", BAILIAN_API_KEY: "" },
      productStateRepository: repository,
      knowledgeIndexRepository: repo,
      bailianChatClient: fakeChatClient as never,
      embeddingClient: fakeEmbedding as never
    });

    const res = await server.inject({ method: "POST", url: "/api/chat", payload: { message: "我担心什么?" } });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(hybridCalls).toHaveLength(1);
    expect(listAllCalls()).toBe(0);   // 精排全零不再回落全表
    expect(body.citations).toHaveLength(0);
    expect(body.citations.some((c: any) => c.sourceId === "irrelevant")).toBe(false);
    const session = body.state.chatSessions.find((s: any) => s.id === body.sessionId);
    expect(session.messages).toHaveLength(2);

    await server.close();
  });

  // 真实性重构:OFFLINE_ANSWER 降级文案已删除——无 chatClient 即对话不可用,如实 503,消息不入库。
  it("无 bailianChatClient → 503（不再存降级文案冒充回答，消息不入库）", async () => {
    const repository = createInMemoryProductStateRepository(createInitialProductState());
    const knowledgeIndexRepository = await seedKnowledge();

    const server = buildApiServer({
      env: { DASHSCOPE_API_KEY: "", BAILIAN_API_KEY: "" },
      productStateRepository: repository,
      knowledgeIndexRepository
      // no bailianChatClient
    });

    const res = await server.inject({
      method: "POST",
      url: "/api/chat",
      payload: { message: "我担心什么?" }
    });

    expect(res.statusCode).toBe(503);
    expect(res.json().error).toContain("未配置");
    // 原子失败:会话与消息都未持久化
    expect(repository.getState().chatSessions).toHaveLength(0);

    await server.close();
  });

  it("模型输出越界 citation 编号时返回 502，且本轮不入库", async () => {
    const repository = createInMemoryProductStateRepository(createInitialProductState());
    const server = buildApiServer({
      env: { DASHSCOPE_API_KEY: "", BAILIAN_API_KEY: "" },
      productStateRepository: repository,
      knowledgeIndexRepository: await seedKnowledge(),
      bailianChatClient: { complete: async () => "根据你的资料[9]，你担心放权失控。" } as never
    });

    const res = await server.inject({ method: "POST", url: "/api/chat", payload: { message: "我担心什么?" } });

    expect(res.statusCode).toBe(502);
    expect(res.json().error).toContain("引用编号");
    expect(repository.getState().chatSessions).toHaveLength(0);
    await server.close();
  });

  it("memory 来源被回答称为用户原话时返回 502，且不保存错误来源断言", async () => {
    const repository = createInMemoryProductStateRepository(createInitialProductState());
    const server = buildApiServer({
      env: { DASHSCOPE_API_KEY: "", BAILIAN_API_KEY: "" },
      productStateRepository: repository,
      knowledgeIndexRepository: await seedKnowledge(),
      bailianChatClient: { complete: async () => "根据你的用户原话[1]，你担心放权失控。" } as never
    });

    const res = await server.inject({ method: "POST", url: "/api/chat", payload: { message: "我担心什么?" } });

    expect(res.statusCode).toBe(502);
    expect(res.json().error).toContain("来源类型");
    expect(repository.getState().chatSessions).toHaveLength(0);
    await server.close();
  });

  it("只引用检索列表第 2 项时保留 citation number=2 和服务端来源标签", async () => {
    const repository = createInMemoryProductStateRepository(createInitialProductState());
    const knowledgeIndexRepository = createInMemoryKnowledgeIndexRepository();
    await knowledgeIndexRepository.put(makeChunk({
      id: "k-first", sourceType: "point", sourceId: "point-1", title: "授权观点",
      text: "放权需要明确决策边界。", keywords: ["放权", "决策", "边界"]
    }));
    await knowledgeIndexRepository.put(makeChunk({
      id: "k-second", sourceType: "memory", sourceId: "memory-2", title: "失控担忧",
      text: "我担心放权之后团队失控。", keywords: ["担心", "放权", "失控"]
    }));
    const server = buildApiServer({
      env: { DASHSCOPE_API_KEY: "", BAILIAN_API_KEY: "" },
      productStateRepository: repository,
      knowledgeIndexRepository,
      bailianChatClient: { complete: async () => "已确认长期记忆[2]显示，你担心放权后的失控。" } as never
    });

    const res = await server.inject({ method: "POST", url: "/api/chat", payload: { message: "放权" } });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.citations).toHaveLength(1);
    expect(body.citations[0].number).toBe(2);
    expect(body.citations[0].sourceType).toBe("memory");
    expect(body.citations[0].sourceLabel).toBe("已确认长期记忆");
    expect(body.state.chatSessions[0].messages[1].citations).toEqual(body.citations);
    await server.close();
  });

  it("focusSource pins that asset as [1] even when recall would rank something else first", async () => {
    const repository = createInMemoryProductStateRepository(createInitialProductState());
    const knowledgeIndexRepository = await seedKnowledge();
    const server = buildApiServer({
      env: { DASHSCOPE_API_KEY: "", BAILIAN_API_KEY: "" },
      productStateRepository: repository,
      knowledgeIndexRepository,
      bailianChatClient: { complete: async () => "观点[1]说你不该继续亲自救火。" } as never
    });
    const res = await server.inject({
      method: "POST",
      url: "/api/chat",
      payload: {
        message: "今天天气不错吗",
        focusSource: { sourceType: "point", sourceId: "point-seed-1" }
      }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.citations[0].sourceType).toBe("point");
    expect(body.citations[0].sourceId).toBe("point-seed-1");
    expect(body.citations[0].number).toBe(1);
    await server.close();
  });
});

