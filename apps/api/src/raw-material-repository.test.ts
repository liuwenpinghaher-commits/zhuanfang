import { describe, it, expect } from "vitest";
import { createInMemoryRawMaterialRepository } from "./raw-material-repository";
import type { InterviewRawMaterial } from "../../../src/domain/types";

const material = (id: string): InterviewRawMaterial => ({
  sessionId: id, turns: [], strategyTrace: [], createdAt: "2026-06-21T00:00:00.000Z"
});

// R2a:仓库接口已异步化,全部调用 await。
describe("in-memory RawMaterialRepository", () => {
  it("put 后能 get 回来,不存在返回 undefined", async () => {
    const repo = createInMemoryRawMaterialRepository();
    expect(await repo.get("s1")).toBeUndefined();
    await repo.put(material("s1"));
    expect((await repo.get("s1"))?.sessionId).toBe("s1");
  });
  it("delete 删单条, deleteAll 清空", async () => {
    const repo = createInMemoryRawMaterialRepository();
    await repo.put(material("s1")); await repo.put(material("s2"));
    await repo.delete("s1");
    expect(await repo.get("s1")).toBeUndefined();
    expect((await repo.get("s2"))?.sessionId).toBe("s2");
    await repo.deleteAll();
    expect(await repo.get("s2")).toBeUndefined();
  });
});
