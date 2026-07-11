import { describe, it, expect } from "vitest";
import { asNativeRecall } from "./native-recall-capability";
import { createInMemoryProductStateRepository } from "../product-state-repository";
import { withKnowledgeReindex } from "../server";
import { createLlmBudget } from "../llm-budget";

// R7:sqlite/dual 已删除,注入矩阵收敛为 memory|surreal 两档。这里用内存仓库当"非原生"基底,
// 在其上挂 recall* 方法结构等价 SurrealRepoHandle(测试用),验证 asNativeRecall 只认原生形态。
function memoryRepo() {
  return createInMemoryProductStateRepository();
}
/** 内存仓库上挂 recall* → 结构等价 SurrealRepoHandle(测试用)。 */
function fakeSurreal() {
  return Object.assign(memoryRepo(), {
    recallThemeAssets: async () => ({ points: [], decisions: [], questions: [], memories: [] }),
    recallMemoriesByVector: async () => [] as Array<{ id: string; text: string }>,
    recallProvenanceTurns: async () => [] as Array<{ id: string; content: string; sessionId: string; role: string }>
  });
}

describe("asNativeRecall 注入矩阵(R7:memory|surreal)", () => {
  it("surreal:repo 自身可召回", () => {
    expect(asNativeRecall(fakeSurreal())).toBeDefined();
  });
  it("memory:undefined(域层回落)", () => {
    expect(asNativeRecall(memoryRepo())).toBeUndefined();
  });
});

// P2b 生产可达性回归:路由拿到的是 withKnowledgeReindex 包装 repo。此前包装只回 4 个接口方法,
// 把原生召回能力全部吞掉 → asNativeRecall(wrapped) 恒 undefined,原生召回在生产静默失效
// (fail-safe 回落掩盖)。修复 = spread 能力透传;此处钉死两种档位。
describe("withKnowledgeReindex 能力透传(生产接线回归)", () => {
  const reindexArgs = () =>
    [{} as Parameters<typeof withKnowledgeReindex>[1], () => undefined, createLlmBudget()] as const;
  it("包装 surreal 形态:原生召回仍可达", () => {
    const wrapped = withKnowledgeReindex(fakeSurreal(), ...reindexArgs());
    expect(asNativeRecall(wrapped)).toBeDefined();
  });
  it("包装 memory 形态:仍 undefined(不虚报能力)", () => {
    const wrapped = withKnowledgeReindex(memoryRepo(), ...reindexArgs());
    expect(asNativeRecall(wrapped)).toBeUndefined();
  });
});
