import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asNativeRecall } from "./native-recall-capability";
import { createDualWriteRepository } from "../dual-write-repository";
import { createSqliteProductStateRepository } from "../../../../packages/db/src/sqlite-product-state-repository";

const dirs: string[] = [];
function sqliteRepo() {
  const dir = mkdtempSync(join(tmpdir(), "p2b-cap-"));
  dirs.push(dir);
  return createSqliteProductStateRepository({ dbPath: join(dir, "s.db") });
}
/** sqlite 上挂 recall* → 结构等价 SurrealRepoHandle(测试用)。 */
function fakeSurreal() {
  return Object.assign(sqliteRepo(), {
    recallThemeAssets: async () => ({ points: [], decisions: [], questions: [], memories: [] }),
    recallMemoriesByVector: async () => [] as Array<{ id: string; text: string }>,
    recallProvenanceTurns: async () => [] as Array<{ id: string; content: string; sessionId: string; role: string }>
  });
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

describe("asNativeRecall 注入矩阵", () => {
  it("surreal:repo 自身可召回", () => {
    expect(asNativeRecall(fakeSurreal())).toBeDefined();
  });
  it("sqlite:undefined(域层回落)", () => {
    expect(asNativeRecall(sqliteRepo())).toBeUndefined();
  });
  it("dual(auth=sqlite):undefined(权威是 sqlite,不走原生)", () => {
    const repo = createDualWriteRepository({ authoritative: sqliteRepo(), shadow: sqliteRepo() });
    expect(asNativeRecall(repo)).toBeUndefined();
  });
  it("dual-surreal(auth=surreal):转发 authoritative", () => {
    const repo = createDualWriteRepository({ authoritative: fakeSurreal(), shadow: sqliteRepo() });
    expect(asNativeRecall(repo)).toBeDefined();
  });
});
