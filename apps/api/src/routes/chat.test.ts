import { describe, expect, it } from "vitest";
import { buildApiServer } from "../server";
import { createInMemoryProductStateRepository } from "../product-state-repository";
import { createInMemoryKnowledgeIndexRepository } from "../knowledge-index-repository";
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

    await server.close();
  });

  it("同会话追加: 第二次带 sessionId → messages 变 4 条", async () => {
    const repository = createInMemoryProductStateRepository(createInitialProductState());
    const knowledgeIndexRepository = await seedKnowledge();
    const fakeChatClient = { complete: async () => "根据你的资料[1]..." };

    const server = buildApiServer({
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

  it("离线: 无 bailianChatClient → assistant 是降级文案, 不报错", async () => {
    const repository = createInMemoryProductStateRepository(createInitialProductState());
    const knowledgeIndexRepository = await seedKnowledge();

    const server = buildApiServer({
      productStateRepository: repository,
      knowledgeIndexRepository
      // no bailianChatClient
    });

    const res = await server.inject({
      method: "POST",
      url: "/api/chat",
      payload: { message: "我担心什么?" }
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.answer).toContain("对话暂不可用");
    expect(body.citations).toHaveLength(0);
    const session = body.state.chatSessions.find((s: any) => s.id === body.sessionId);
    expect(session.messages).toHaveLength(2);
    expect(session.messages[1].role).toBe("assistant");

    await server.close();
  });
});
