import { describe, it, expect } from "vitest";
import { createInMemoryKnowledgeIndexRepository } from "./knowledge-index-repository";
import type { KnowledgeChunk } from "../../../src/domain/types";
const mk = (id: string, sourceType: KnowledgeChunk["sourceType"], sourceId: string): KnowledgeChunk => ({
  id, sourceType, sourceId, title: "t", text: "x", keywords: [], createdAt: "2026-06-22T00:00:00.000Z"
});
describe("in-memory KnowledgeIndexRepository", () => {
  it("put/listAll, deleteBySource 删该来源全部块, deleteAll", () => {
    const r = createInMemoryKnowledgeIndexRepository();
    r.put(mk("c1", "note", "s1")); r.put(mk("c2", "note", "s1")); r.put(mk("c3", "memory", "m1"));
    expect(r.listAll()).toHaveLength(3);
    r.deleteBySource("note", "s1");
    expect(r.listAll().map((c) => c.id)).toEqual(["c3"]);
    r.deleteAll();
    expect(r.listAll()).toHaveLength(0);
  });
  it("replaceSource 原子替换某来源的块", () => {
    const r = createInMemoryKnowledgeIndexRepository();
    r.put(mk("c1", "note", "s1"));
    r.replaceSource("note", "s1", [mk("c2", "note", "s1"), mk("c3", "note", "s1")]);
    expect(r.listAll().map((c) => c.id).sort()).toEqual(["c2", "c3"]);
  });
});
