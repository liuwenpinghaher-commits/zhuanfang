import { describe, it, expect } from "vitest";
import { createSqliteRawMaterialRepository } from "./sqlite-raw-material-repository";
import type { InterviewRawMaterial } from "../../../src/domain/types";

const mk = (id: string): InterviewRawMaterial => ({
  sessionId: id,
  turns: [{ id: "t1", role: "user", content: "原话", intent: "", timestamp: "2026-06-21T00:00:00.000Z" }],
  strategyTrace: [],
  createdAt: "2026-06-21T00:00:00.000Z"
});

describe("sqlite RawMaterialRepository", () => {
  it("put→get 往返,跨实例持久(同 dbPath)", () => {
    const repo = createSqliteRawMaterialRepository({ dbPath: ":memory:" });
    repo.put(mk("s1"));
    expect(repo.get("s1")?.turns[0].content).toBe("原话");
    expect(repo.get("missing")).toBeUndefined();
  });
  it("delete / deleteAll", () => {
    const repo = createSqliteRawMaterialRepository({ dbPath: ":memory:" });
    repo.put(mk("s1")); repo.put(mk("s2"));
    repo.delete("s1");
    expect(repo.get("s1")).toBeUndefined();
    repo.deleteAll();
    expect(repo.get("s2")).toBeUndefined();
  });
});
