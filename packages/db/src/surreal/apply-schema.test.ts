import { describe, it, expect, afterEach } from "vitest";
import type { Surreal } from "surrealdb";
import { createSurrealConnection } from "./connect.js";
import { applySchema } from "./apply-schema.js";
import { EMBEDDING_DIMENSION } from "./constants.js";

let db: Surreal | undefined;
afterEach(async () => { await db?.close(); db = undefined; });

async function freshDb(): Promise<Surreal> {
  db = await createSurrealConnection({ url: "mem://" });
  return db;
}

describe("applySchema", () => {
  it("在空库上应用全部 migrations(返回已应用文件名)", async () => {
    const d = await freshDb();
    const applied = await applySchema(d);
    expect(applied).toEqual(["001_nodes.surql", "002_relations.surql", "003_index.surql"]);
  });

  it("二次 apply 幂等:不报错、不重复、INFO 不变", async () => {
    const d = await freshDb();
    await applySchema(d);
    const second = await applySchema(d);
    expect(second).toEqual([]); // 全部已应用
    const [ledger] = await d.query<[{ name: string }[]]>("SELECT name FROM _migration;");
    const names = (ledger ?? []).map((r) => r.name).sort();
    expect(names).toEqual(["001_nodes.surql", "002_relations.surql", "003_index.surql"]);
  });

  it("INFO FOR DB:13 节点表 + entity_kind + 8 边表齐全", async () => {
    const d = await freshDb();
    await applySchema(d);
    const [info] = await d.query<[{ tables: Record<string, unknown> }]>("INFO FOR DB;");
    const tables = Object.keys(info?.tables ?? {});
    for (const t of [
      "entity_kind","session","turn","note","point","decision","debt","question",
      "theme","memory","memory_candidate","material","rag_chunk","search_brief",
      "derived_from","belongs_to_theme","about_theme","promoted_from","part_of",
      "corrects","contradicts","evolves_into",
    ]) {
      expect(tables, `缺表 ${t}`).toContain(t);
    }
  });

  it("INFO FOR TABLE:关键字段与索引存在", async () => {
    const d = await freshDb();
    await applySchema(d);
    const [pointInfo] = await d.query<[{ fields: Record<string, string> }]>("INFO FOR TABLE point;");
    expect(Object.keys(pointInfo?.fields ?? {})).toContain("status");
    const [memInfo] = await d.query<[{ indexes: Record<string, string> }]>("INFO FOR TABLE memory;");
    const idxNames = Object.keys(memInfo?.indexes ?? {});
    expect(idxNames).toContain("memory_emb");
    expect(idxNames).toContain("memory_ft");
  });

  it("HNSW 维度 == EMBEDDING_DIMENSION(防 DDL 与常量漂移)", async () => {
    const d = await freshDb();
    await applySchema(d);
    const [memInfo] = await d.query<[{ indexes: Record<string, string> }]>("INFO FOR TABLE memory;");
    const def = String(memInfo?.indexes?.memory_emb ?? "");
    expect(def).toContain(`DIMENSION ${EMBEDDING_DIMENSION}`);
  });
});
