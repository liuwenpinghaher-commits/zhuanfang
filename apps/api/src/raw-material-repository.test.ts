import { describe, it, expect } from "vitest";
import { createInMemoryRawMaterialRepository } from "./raw-material-repository";
import type { InterviewRawMaterial } from "../../../src/domain/types";

const material = (id: string): InterviewRawMaterial => ({
  sessionId: id, turns: [], strategyTrace: [], createdAt: "2026-06-21T00:00:00.000Z"
});

describe("in-memory RawMaterialRepository", () => {
  it("put 后能 get 回来,不存在返回 undefined", () => {
    const repo = createInMemoryRawMaterialRepository();
    expect(repo.get("s1")).toBeUndefined();
    repo.put(material("s1"));
    expect(repo.get("s1")?.sessionId).toBe("s1");
  });
  it("delete 删单条, deleteAll 清空", () => {
    const repo = createInMemoryRawMaterialRepository();
    repo.put(material("s1")); repo.put(material("s2"));
    repo.delete("s1");
    expect(repo.get("s1")).toBeUndefined();
    expect(repo.get("s2")?.sessionId).toBe("s2");
    repo.deleteAll();
    expect(repo.get("s2")).toBeUndefined();
  });
});
