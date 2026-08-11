import { describe, it, expect } from "vitest";
import { asNativeRecall } from "./native-recall-capability";
import { createInMemoryProductStateRepository } from "../product-state-repository";
import { withKnowledgeReindex } from "../server";
import { createLlmBudget } from "../llm-budget";
import { createUserScopedProductStateRepository } from "../auth/user-scoped-repository";
import { asGovernanceTx } from "../governance/governance-tx-capability";
import { SURREAL_CAPABILITY_KEYS } from "./surreal-capability-keys";

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

/** C11:结构等价完整 Surreal handle(召回 + 治理 + 健康/审计)供装配契约测。 */
function fakeSurrealFullCaps() {
  return Object.assign(fakeSurreal(), {
    runGovernanceTransaction: async () => memoryRepo().getState(),
    getPersistHealth: () => ({ consecutiveFailures: 0 }),
    auditGraphConsistency: async () => ({ ok: true }),
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
// (fail-safe 回落掩盖)。修复 = live getter + Proxy 转发(禁止 object spread Proxy)。
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

// C11:能力清单同源 + 装配链 withKnowledgeReindex(userScopedFacade(fakeSurreal)) 契约钉。
// USER_SCOPED=1 时 inner 是 Proxy;withKnowledgeReindex 必须 live 转发,不可 {...inner}。
describe("C11 Surreal 能力清单 · 装配契约", () => {
  const reindexArgs = () =>
    [{} as Parameters<typeof withKnowledgeReindex>[1], () => undefined, createLlmBudget()] as const;

  it("SURREAL_CAPABILITY_KEYS 覆盖 hasNativeRecall / asGovernanceTx 探测面", () => {
    expect(SURREAL_CAPABILITY_KEYS).toContain("runGovernanceTransaction");
    expect(SURREAL_CAPABILITY_KEYS).toContain("recallThemeAssets");
    expect(SURREAL_CAPABILITY_KEYS).toContain("recallMemoriesByVector");
    expect(SURREAL_CAPABILITY_KEYS).toContain("recallProvenanceTurns");
    expect(SURREAL_CAPABILITY_KEYS).toContain("getPersistHealth");
    expect(SURREAL_CAPABILITY_KEYS).toContain("auditGraphConsistency");
  });

  it("withKnowledgeReindex(userScopedFacade(fakeSurreal)) 对每个能力键 typeof === function", () => {
    const scoped = createUserScopedProductStateRepository({
      getOrCreate: () => fakeSurrealFullCaps() as ReturnType<typeof createInMemoryProductStateRepository>,
      fallbackUsername: "c11-test-user",
    });
    // 钉死「Proxy 能力在 spread 后丢失」的反例:裸 spread 不应出现在生产 withKnowledgeReindex。
    const spreadKeys = Object.keys({ ...scoped });
    for (const key of SURREAL_CAPABILITY_KEYS) {
      expect(spreadKeys.includes(key), `spread must NOT own ${key} (Proxy trap only)`).toBe(false);
    }
    const wrapped = withKnowledgeReindex(scoped, ...reindexArgs());
    for (const key of SURREAL_CAPABILITY_KEYS) {
      expect(typeof (wrapped as Record<string, unknown>)[key], `capability ${key}`).toBe("function");
      expect(key in wrapped, `in-probe ${key}`).toBe(true);
    }
    // 路由探测面仍可达
    expect(asNativeRecall(wrapped)).toBeDefined();
    expect(asGovernanceTx(wrapped)).toBeDefined();
  });
});
