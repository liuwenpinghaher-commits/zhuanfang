import { describe, expect, it } from "vitest";
import { buildApiServer } from "../server";
import { createInMemoryKnowledgeIndexRepository } from "../knowledge-index-repository";
import { embedChunks } from "./knowledge";
import { createLlmBudget } from "../llm-budget";
import type { KnowledgeChunk } from "../../../../src/domain/types";
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

    const all = knowledgeIndexRepository.listAll();
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
    expect(knowledgeIndexRepository.listAll().length).toBe(first.chunkCount);

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
