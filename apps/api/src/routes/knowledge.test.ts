import { describe, expect, it } from "vitest";
import { buildApiServer } from "../server";
import { createInMemoryKnowledgeIndexRepository, type KnowledgeIndexRepository } from "../knowledge-index-repository";
import { embedChunks, reindexOnStateChange } from "./knowledge";
import { createLlmBudget } from "../llm-budget";
import { createInitialProductState } from "../../../../src/domain/engine";
import type { KnowledgeChunk, MemoryRecord, ProductState } from "../../../../src/domain/types";
import type { BailianEmbeddingClient } from "../providers/bailian";

function makeChunk(id: string): KnowledgeChunk {
  return {
    id,
    sourceType: "point",
    sourceId: `src_${id}`,
    title: `标题 ${id}`,
    text: `内容 ${id}`,
    keywords: ["内容"],
    createdAt: new Date().toISOString()
  };
}

describe("POST /api/knowledge/rebuild", () => {
  it("从 seed 资产重建索引：200、chunkCount>=1、含 theme/point 块、无 embeddingClient 时 embedding 为空(关键词兜底)", async () => {
    const knowledgeIndexRepository = createInMemoryKnowledgeIndexRepository();
    const server = buildApiServer({ env: {}, knowledgeIndexRepository });

    const res = await server.inject({ method: "POST", url: "/api/knowledge/rebuild" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { chunkCount: number };
    expect(body.chunkCount).toBeGreaterThanOrEqual(1);

    const all = await knowledgeIndexRepository.listAll();
    expect(all.length).toBe(body.chunkCount);
    expect(all.length).toBeGreaterThanOrEqual(1);

    // seed 资产里有 theme/point，索引应含这些来源类型的块。
    const sourceTypes = new Set(all.map((c) => c.sourceType));
    expect(sourceTypes.has("theme") || sourceTypes.has("point")).toBe(true);

    // env:{} 下无 embeddingClient → 块不挂 embedding，走关键词兜底，不报错。
    expect(all.every((c) => c.embedding === undefined)).toBe(true);

    await server.close();
  });

  it("重复 rebuild 不累加(deleteAll 先清空)", async () => {
    const knowledgeIndexRepository = createInMemoryKnowledgeIndexRepository();
    const server = buildApiServer({ env: {}, knowledgeIndexRepository });

    const first = (await server.inject({ method: "POST", url: "/api/knowledge/rebuild" })).json() as {
      chunkCount: number;
    };
    const second = (await server.inject({ method: "POST", url: "/api/knowledge/rebuild" })).json() as {
      chunkCount: number;
    };
    expect(second.chunkCount).toBe(first.chunkCount);
    expect((await knowledgeIndexRepository.listAll()).length).toBe(first.chunkCount);

    await server.close();
  });
});

describe("embedChunks", () => {
  it("无 embeddingClient → 原样返回，块不挂 embedding", async () => {
    const chunks = [makeChunk("a"), makeChunk("b")];
    const out = await embedChunks(chunks, undefined, createLlmBudget());
    expect(out).toHaveLength(2);
    expect(out.every((c) => c.embedding === undefined)).toBe(true);
  });

  it("超预算(cap=0) → 原样返回，不调用 client", async () => {
    let called = false;
    const client: BailianEmbeddingClient = {
      async embed(texts) {
        called = true;
        return texts.map(() => [1, 0, 0]);
      }
    };
    const out = await embedChunks([makeChunk("a")], client, createLlmBudget({ maxCallsPerSession: 0 }));
    expect(called).toBe(false);
    expect(out[0].embedding).toBeUndefined();
  });

  it("有 client 且预算够 → 批量补嵌入", async () => {
    const client: BailianEmbeddingClient = {
      async embed(texts) {
        return texts.map((_, i) => [i, 1, 0]);
      }
    };
    const out = await embedChunks([makeChunk("a"), makeChunk("b")], client, createLlmBudget());
    expect(out[0].embedding).toEqual([0, 1, 0]);
    expect(out[1].embedding).toEqual([1, 1, 0]);
  });

  it("client.embed 抛错 → 吞掉异常，已补的保留、其余留空，绝不抛", async () => {
    const client: BailianEmbeddingClient = {
      async embed() {
        throw new Error("boom");
      }
    };
    const out = await embedChunks([makeChunk("a")], client, createLlmBudget());
    expect(out[0].embedding).toBeUndefined();
  });
});

describe("reindexOnStateChange", () => {
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

  it("修改一条 memory → 该来源块被替换为新内容；删除一条 → 块被清除", async () => {
    const base = createInitialProductState();
    const prev: ProductState = {
      ...base,
      memoryRecords: [rec("m1", "旧文本"), rec("m2", "将删除")]
    };
    const next: ProductState = {
      ...base,
      memoryRecords: [rec("m1", "新文本")]
    };
    const repo = createInMemoryKnowledgeIndexRepository();
    // 预置：m1/m2 的旧块各一条
    await repo.put({ ...makeChunk("old1"), sourceType: "memory", sourceId: "m1", text: "旧文本" });
    await repo.put({ ...makeChunk("old2"), sourceType: "memory", sourceId: "m2", text: "将删除" });

    await reindexOnStateChange(prev, next, repo, undefined, createLlmBudget());

    const all = await repo.listAll();
    const m1 = all.filter((c) => c.sourceType === "memory" && c.sourceId === "m1");
    const m2 = all.filter((c) => c.sourceType === "memory" && c.sourceId === "m2");
    expect(m1).toHaveLength(1);
    expect(m1[0].text).toBe("新文本"); // 被重建为新内容
    expect(m2).toHaveLength(0); // 删除来源的块被清除
  });

  it("无变更 → 不动索引、不抛", async () => {
    const base = createInitialProductState();
    const repo = createInMemoryKnowledgeIndexRepository();
    await repo.put({ ...makeChunk("k"), sourceType: "memory", sourceId: "m1" });
    await reindexOnStateChange(base, base, repo, undefined, createLlmBudget());
    expect(await repo.listAll()).toHaveLength(1);
  });

  it("N-04:回写循环中途 reset/purge 清空索引(epoch 递增)→ 剩余来源不再写回(不复活已清私密块)", async () => {
    const base = createInitialProductState();
    // 两条新 memory → diff.changed 含 m1、m2 两个来源,写回循环逐源 replaceSource(≥2 次迭代)。
    const prev: ProductState = { ...base, memoryRecords: [] };
    const next: ProductState = { ...base, memoryRecords: [rec("m1", "私密一"), rec("m2", "私密二")] };

    // 可控 epoch 的假索引:首次 replaceSource 即模拟"并发 reset/purge 提交清空索引"(bumpEpoch=epoch+1),
    // 使第二源在循环内 epoch 复查命中(1≠捕获的 0)→ 剩余源被丢弃。记录实际写入来源以断言。
    let epoch = 0;
    const written: string[] = [];
    const repo: KnowledgeIndexRepository = {
      async put() {},
      async replaceSource(_t, id) { written.push(id); epoch += 1; }, // 首次写回即"被清空"
      async deleteBySource() {},
      async deleteAll() { epoch += 1; },
      async listAll() { return []; },
      async epoch() { return epoch; }
    };

    await reindexOnStateChange(prev, next, repo, undefined, createLlmBudget());

    // 修前:循环只在开头查一次 epoch → 两源都 replaceSource(written=[m1,m2]),把 reset 前构建的私密块
    // 写回已清空索引 → chat 再召回"已清空"的私人内容。修后:每源循环前复查 epoch,第二源即断,只写第一源。
    expect(written).toEqual(["m1"]);
  });

  it("删除一条 importSource → 其 material 孤儿块被清除(终审#1)", async () => {
    const base = createInitialProductState();
    const at = "2026-06-22T00:00:00.000Z";
    const prev: ProductState = {
      ...base,
      importSources: [
        {
          id: "s1",
          title: "素材一",
          sourceType: "text",
          content: "正文一",
          status: "chunked",
          sensitivity: "normal",
          chunkIds: [],
          createdAt: at,
          updatedAt: at
        }
      ]
    };
    const next: ProductState = { ...base, importSources: [] };
    const repo = createInMemoryKnowledgeIndexRepository();
    // 预置：s1 的 material 块
    await repo.put({ ...makeChunk("mat1"), sourceType: "material", sourceId: "s1", text: "正文一" });

    await reindexOnStateChange(prev, next, repo, undefined, createLlmBudget());

    const orphan = (await repo.listAll()).filter((c) => c.sourceType === "material" && c.sourceId === "s1");
    expect(orphan).toHaveLength(0);
  });

  it("一个会话从 sessions[] 消失 → 其 transcript 孤儿块被清除(防御:跨库一致性)", async () => {
    const base = createInitialProductState();
    const prev: ProductState = {
      ...base,
      sessions: [{ id: "sess-x" } as any, ...base.sessions]
    };
    const next: ProductState = { ...base, sessions: [...base.sessions] };
    const repo = createInMemoryKnowledgeIndexRepository();
    // 预置：sess-x 的两条 transcript 块(sourceId 形如 sessionId#turnId)
    await repo.put({ ...makeChunk("tc1"), sourceType: "transcript", sourceId: "sess-x#t1", text: "轮一" });
    await repo.put({ ...makeChunk("tc2"), sourceType: "transcript", sourceId: "sess-x#t2", text: "轮二" });

    await reindexOnStateChange(prev, next, repo, undefined, createLlmBudget());

    const orphan = (await repo.listAll()).filter((c) => c.sourceType === "transcript" && c.sourceId.startsWith("sess-x#"));
    expect(orphan).toHaveLength(0);
  });
});

describe("PUT /api/state 触发增量重索引(经包装的 replaceState)", () => {
  it("PUT 改一条 theme summary 后，knowledgeRepo 里该 theme 的块被更新为新内容", async () => {
    const knowledgeIndexRepository = createInMemoryKnowledgeIndexRepository();
    const server = buildApiServer({ env: {}, knowledgeIndexRepository });
    // 先全量建索引，确保 theme 块入库
    await server.inject({ method: "POST", url: "/api/knowledge/rebuild" });

    const cur = (await server.inject({ method: "GET", url: "/api/state" })).json() as ProductState;
    const target = cur.themes[0];
    expect(target).toBeDefined();
    const newSummary = "增量索引验证：被修改的主题摘要";
    const nextState: ProductState = {
      ...cur,
      themes: cur.themes.map((t, i) => (i === 0 ? { ...t, summary: newSummary } : t))
    };

    const put = await server.inject({ method: "PUT", url: "/api/state", payload: nextState });
    expect(put.statusCode).toBe(200);

    // reindex 是 fire-and-forget(微任务)，让事件循环转一圈再断言。
    await new Promise((r) => setTimeout(r, 20));

    const block = (await knowledgeIndexRepository.listAll()).find((c) => c.sourceType === "theme" && c.sourceId === target.id);
    expect(block).toBeDefined();
    expect(block?.text).toContain(newSummary);

    await server.close();
  });
});
