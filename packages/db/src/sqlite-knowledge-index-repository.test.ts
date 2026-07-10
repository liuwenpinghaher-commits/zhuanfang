import { describe, it, expect } from "vitest";
import { createSqliteKnowledgeIndexRepository } from "./sqlite-knowledge-index-repository";
import type { KnowledgeChunk } from "../../../src/domain/types";

const mk = (id: string, src: string, emb?: number[]): KnowledgeChunk => ({
  id,
  sourceType: "note",
  sourceId: src,
  title: "t",
  text: "原文",
  keywords: ["a", "b"],
  ...(emb ? { embedding: emb } : {}),
  createdAt: "2026-06-22T00:00:00.000Z"
});

// R2a:仓库接口已异步化,全部调用 await。
describe("sqlite KnowledgeIndexRepository", () => {
  it("put→listAll 往返(含 embedding/keywords), replaceSource, deleteBySource/All", async () => {
    const r = createSqliteKnowledgeIndexRepository({ dbPath: ":memory:" });
    await r.put(mk("c1", "s1", [0.1, 0.2, 0.3]));
    const all = await r.listAll();
    expect(all[0].embedding).toEqual([0.1, 0.2, 0.3]);
    expect(all[0].keywords).toEqual(["a", "b"]);
    await r.replaceSource("note", "s1", [mk("c2", "s1")]);
    expect((await r.listAll()).map((c) => c.id)).toEqual(["c2"]);
    expect((await r.listAll())[0].embedding).toBeUndefined(); // 无 emb 时不挂字段
    await r.deleteBySource("note", "s1");
    expect(await r.listAll()).toHaveLength(0);
  });
});
