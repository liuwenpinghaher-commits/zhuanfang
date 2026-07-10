import { describe, it, expect } from "vitest";
import { createSqliteRawMaterialRepository } from "./sqlite-raw-material-repository";
import type { InterviewRawMaterial } from "../../../src/domain/types";

const mk = (id: string): InterviewRawMaterial => ({
  sessionId: id,
  turns: [{ id: "t1", role: "user", content: "原话", intent: "", timestamp: "2026-06-21T00:00:00.000Z" }],
  strategyTrace: [],
  createdAt: "2026-06-21T00:00:00.000Z"
});

// R2a:仓库接口已异步化,全部调用 await。
describe("sqlite RawMaterialRepository", () => {
  it("put→get 往返,跨实例持久(同 dbPath)", async () => {
    const repo = createSqliteRawMaterialRepository({ dbPath: ":memory:" });
    await repo.put(mk("s1"));
    expect((await repo.get("s1"))?.turns[0].content).toBe("原话");
    expect(await repo.get("missing")).toBeUndefined();
  });
  it("delete / deleteAll", async () => {
    const repo = createSqliteRawMaterialRepository({ dbPath: ":memory:" });
    await repo.put(mk("s1")); await repo.put(mk("s2"));
    await repo.delete("s1");
    expect(await repo.get("s1")).toBeUndefined();
    await repo.deleteAll();
    expect(await repo.get("s2")).toBeUndefined();
  });
});
