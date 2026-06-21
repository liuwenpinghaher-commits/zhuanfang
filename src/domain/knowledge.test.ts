import { describe, it, expect } from "vitest";
import { buildKnowledgeChunks, diffIndexableSources, createChatSession, appendChatMessage, renameChatSession, deleteChatSession, rankKnowledgeChunks, buildChatPrompt } from "./knowledge";
import { createInitialProductState } from "./engine";
import type { ChatMessage, InterviewTurn, KnowledgeChunk, MemoryRecord, ProductState } from "./types";

describe("buildKnowledgeChunks", () => {
  it("把蒸馏资产各切成块,带 sourceType/sourceId,离线无嵌入", () => {
    const state = createInitialProductState(); // seed 含 themes/points/memory 等
    const chunks = buildKnowledgeChunks(state, new Map());
    const types = new Set(chunks.map((c) => c.sourceType));
    expect(chunks.length).toBeGreaterThan(0);
    expect([...types].some((t) => ["memory", "theme", "point", "note"].includes(t))).toBe(true);
    expect(chunks.every((c) => c.id && c.sourceId && c.text)).toBe(true);
    expect(chunks.every((c) => c.embedding === undefined)).toBe(true);
  });
  it("transcript 按 user 轮切块(来自冷层 map)", () => {
    const state = createInitialProductState();
    const sid = state.sessions[0]?.id ?? "s1";
    const turns: InterviewTurn[] = [
      { id: "t1", role: "user", content: "我担心放权失控。", intent: "", timestamp: "2026-06-22T00:00:00.000Z" },
      { id: "t2", role: "assistant", content: "为什么?", intent: "", timestamp: "2026-06-22T00:00:00.000Z" }
    ];
    const withSession = { ...state, sessions: state.sessions.length ? state.sessions : [{ id: sid } as any] };
    const chunks = buildKnowledgeChunks(withSession, new Map([[withSession.sessions[0].id, turns]]));
    const t = chunks.filter((c) => c.sourceType === "transcript");
    expect(t.length).toBe(1); // 只 user 轮
    expect(t[0].sourceId).toContain(withSession.sessions[0].id);
    expect(t[0].text).toContain("放权");
  });
});

describe("diffIndexableSources", () => {
  function rec(id: string, text: string): MemoryRecord {
    return {
      id,
      text,
      status: "confirmed",
      sourceType: "interview_session",
      sourceId: "x",
      evidenceQuote: "",
      createdAt: "2026-06-22T00:00:00.000Z",
      updatedAt: "2026-06-22T00:00:00.000Z"
    };
  }

  it("memoryRecords 增/改/删 + themes 改：changed 含新增与修改、removed 含删除、未变不在内", () => {
    const base = createInitialProductState();
    // 用确定的 memoryRecords 作为基线：keep(不变)、edit(将改 text)、drop(将删)
    const prev: ProductState = {
      ...base,
      memoryRecords: [rec("m_keep", "保留原文"), rec("m_edit", "原始文本"), rec("m_drop", "将被删除")]
    };
    const next: ProductState = {
      ...base,
      memoryRecords: [
        rec("m_keep", "保留原文"), // 未变
        rec("m_edit", "修改后的文本"), // 改 text
        rec("m_add", "新增的一条") // 新增
        // m_drop 已删除
      ]
    };

    const diff = diffIndexableSources(prev, next);
    const changedIds = diff.changed.map((r) => r.sourceId);
    const removedIds = diff.removed.map((r) => r.sourceId);

    expect(changedIds).toContain("m_add"); // 新增
    expect(changedIds).toContain("m_edit"); // 修改
    expect(changedIds).not.toContain("m_keep"); // 未变不在 changed
    expect(removedIds).toContain("m_drop"); // 删除
    expect(removedIds).not.toContain("m_keep");
    // sourceType 映射正确
    expect(diff.changed.find((r) => r.sourceId === "m_add")?.sourceType).toBe("memory");
    expect(diff.removed.find((r) => r.sourceId === "m_drop")?.sourceType).toBe("memory");
  });

  it("themes 改一条 summary → 该 theme 进 changed(sourceType=theme)", () => {
    const base = createInitialProductState();
    const t0 = base.themes[0];
    if (!t0) throw new Error("seed 应含至少一个 theme");
    const prev = base;
    const next: ProductState = {
      ...base,
      themes: base.themes.map((t, i) => (i === 0 ? { ...t, summary: `${t.summary} 改动` } : t))
    };
    const diff = diffIndexableSources(prev, next);
    expect(diff.changed.some((r) => r.sourceType === "theme" && r.sourceId === t0.id)).toBe(true);
    // 未变的 theme 不应进 changed
    const otherThemeIds = base.themes.slice(1).map((t) => t.id);
    for (const id of otherThemeIds) {
      expect(diff.changed.some((r) => r.sourceType === "theme" && r.sourceId === id)).toBe(false);
    }
  });

  it("material/transcript 不在 diff 内(由 import//end 单独补)", () => {
    const base = createInitialProductState();
    const prev = base;
    const next: ProductState = {
      ...base,
      importSources: [
        ...base.importSources,
        { id: "imp_new", title: "新资料", content: "正文", sourceType: "text", createdAt: "2026-06-22T00:00:00.000Z" } as any
      ]
    };
    const diff = diffIndexableSources(prev, next);
    expect(diff.changed.some((r) => (r.sourceType as string) === "material")).toBe(false);
    expect(diff.changed.some((r) => (r.sourceType as string) === "transcript")).toBe(false);
  });
});

describe("chat 会话域函数", () => {
  it("createChatSession 建空会话 + 审计", () => {
    const s = createInitialProductState();
    const { state, sessionId } = createChatSession(s, "聊聊");
    expect(state.chatSessions).toHaveLength(1);
    expect(state.chatSessions[0].id).toBe(sessionId);
    expect(state.chatSessions[0].messages).toHaveLength(0);
    expect(state.auditEvents.some((e) => e.type === "chat_session_created")).toBe(true);
  });
  it("appendChatMessage 追加并更新 updatedAt;会话不存在原样返回", () => {
    const { state, sessionId } = createChatSession(createInitialProductState());
    const next = appendChatMessage(state, sessionId, "user", "  我担心什么?  ");
    expect(next.chatSessions[0].messages).toHaveLength(1);
    expect(next.chatSessions[0].messages[0].role).toBe("user");
    expect(next.chatSessions[0].messages[0].content).toBe("我担心什么?"); // trim
    expect(appendChatMessage(state, "nope", "user", "x")).toBe(state);
  });
  it("rename / delete", () => {
    const { state, sessionId } = createChatSession(createInitialProductState());
    expect(renameChatSession(state, sessionId, "新标题").chatSessions[0].title).toBe("新标题");
    expect(deleteChatSession(state, sessionId).chatSessions).toHaveLength(0);
  });
  it("超 50 会话淘汰最旧;不可变", () => {
    let s = createInitialProductState();
    for (let i = 0; i < 52; i++) s = createChatSession(s, `c${i}`).state;
    expect(s.chatSessions.length).toBeLessThanOrEqual(50);
    const before = createInitialProductState();
    createChatSession(before);
    expect(before.chatSessions).toHaveLength(0); // 输入不变
  });
});

function makeKChunk(overrides: Partial<KnowledgeChunk> & { id: string }): KnowledgeChunk {
  return {
    sourceType: "memory",
    sourceId: overrides.id,
    title: "块",
    text: "内容",
    keywords: [],
    createdAt: "2026-06-22T00:00:00.000Z",
    ...overrides
  };
}

describe("rankKnowledgeChunks", () => {
  it("有 queryEmbedding 且块有 embedding → 余弦排序,近的排前", () => {
    const near = makeKChunk({ id: "near", embedding: [1, 0, 0] });
    const far = makeKChunk({ id: "far", embedding: [0, 1, 0] });
    const out = rankKnowledgeChunks([far, near], "query", [1, 0, 0], 8);
    expect(out[0].id).toBe("near"); // cosine=1 排第一
    expect(out[1].id).toBe("far");
  });

  it("无 queryEmbedding → 关键词重叠排序", () => {
    const hit = makeKChunk({ id: "hit", text: "放权失控的担忧", keywords: ["放权", "失控"] });
    const miss = makeKChunk({ id: "miss", text: "天气不错", keywords: ["天气"] });
    const out = rankKnowledgeChunks([miss, hit], "我担心放权失控", undefined, 8);
    expect(out[0].id).toBe("hit");
  });

  it("topK 截断", () => {
    const chunks = Array.from({ length: 10 }, (_, i) =>
      makeKChunk({ id: `c${i}`, text: "放权", keywords: ["放权"] })
    );
    const out = rankKnowledgeChunks(chunks, "放权", undefined, 3);
    expect(out).toHaveLength(3);
  });
});

describe("buildChatPrompt", () => {
  it("system 含区分指令 + 编号资料;user 含 message", () => {
    const retrieved = [
      makeKChunk({ id: "r1", sourceType: "memory", title: "担忧记录", text: "我担心放权失控" })
    ];
    const history: ChatMessage[] = [
      { id: "m1", role: "user", content: "之前的问题", createdAt: "2026-06-22T00:00:00.000Z" },
      { id: "m2", role: "assistant", content: "之前的回答", createdAt: "2026-06-22T00:00:00.000Z" }
    ];
    const { system, user } = buildChatPrompt(retrieved, history, "我现在担心什么?");
    // 区分 '你的资料显示' 与 '我的推断'
    expect(system).toContain("区分");
    expect(system).toContain("[1]"); // 编号资料
    expect(system).toContain("担忧记录");
    expect(user).toContain("我现在担心什么?"); // 当前 message
    expect(user).toContain("之前的问题"); // history 拼接
  });

  it("history 最多 6 条", () => {
    const history: ChatMessage[] = Array.from({ length: 10 }, (_, i) => ({
      id: `m${i}`,
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: `历史消息${i}`,
      createdAt: "2026-06-22T00:00:00.000Z"
    }));
    const { user } = buildChatPrompt([], history, "当前");
    expect(user).not.toContain("历史消息0"); // 最旧被截断
    expect(user).toContain("历史消息9"); // 最新保留
  });
});
