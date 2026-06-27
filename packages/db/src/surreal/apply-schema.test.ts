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
});
