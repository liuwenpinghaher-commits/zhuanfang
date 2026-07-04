import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asNativeRecall } from "./native-recall-capability";
import { createDualWriteRepository } from "../dual-write-repository";
import { createSqliteProductStateRepository } from "../../../../packages/db/src/sqlite-product-state-repository";
import { withKnowledgeReindex } from "../server";
import { createLlmBudget } from "../llm-budget";

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

// P2b 生产可达性回归:路由拿到的是 withKnowledgeReindex 包装 repo。此前包装只回 4 个接口方法,
// 把原生召回能力(及 dual 的 getAuthoritative)全部吞掉 → asNativeRecall(wrapped) 恒 undefined,
// 原生召回在生产静默失效(fail-safe 回落掩盖)。修复 = spread 能力透传;此处钉死两种权威档位。
describe("withKnowledgeReindex 能力透传(生产接线回归)", () => {
  const reindexArgs = () =>
    [{} as Parameters<typeof withKnowledgeReindex>[1], () => undefined, createLlmBudget()] as const;
  it("包装 surreal 形态:原生召回仍可达", () => {
    const wrapped = withKnowledgeReindex(fakeSurreal(), ...reindexArgs());
    expect(asNativeRecall(wrapped)).toBeDefined();
  });
  it("包装 dual-surreal 形态:经 getAuthoritative 仍可达", () => {
    const repo = createDualWriteRepository({ authoritative: fakeSurreal(), shadow: sqliteRepo() });
    const wrapped = withKnowledgeReindex(repo, ...reindexArgs());
    expect(asNativeRecall(wrapped)).toBeDefined();
  });
  it("包装 sqlite 形态:仍 undefined(不虚报能力)", () => {
    const wrapped = withKnowledgeReindex(sqliteRepo(), ...reindexArgs());
    expect(asNativeRecall(wrapped)).toBeUndefined();
  });
});
