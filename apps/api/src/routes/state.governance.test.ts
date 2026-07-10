import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import { registerStateRoutes } from "./state";
import { buildApiServer, withKnowledgeReindex } from "../server";
import { createInMemoryProductStateRepository, GovernanceInFlightError, type ProductStateRepository } from "../product-state-repository";
import { createInMemoryRawMaterialRepository } from "../raw-material-repository";
import { createInMemoryAudioRepository } from "../audio-repository";
import { createInMemoryKnowledgeIndexRepository } from "../knowledge-index-repository";
import { asGovernanceTx, type GovernanceColdSpec, type GovernanceHotSpec } from "../governance/governance-tx-capability";
import { createLlmBudget } from "../llm-budget";
import type { ProductState } from "../../../../src/domain/types";

/** R2b · 治理路由(reset/purge/import)对治理事务能力的接线测试。
 *  用**模拟治理端口**(实现 runGovernanceTransaction 的内存 repo)驱动路由的 governance 分支——聚焦
 *  路由自身的逻辑:能力探测、hot/cold 规格翻译、成功回执、失败(整体回滚)→ 500 + 回执标注(不带
 *  state)。真 ACID 原子性/基线推进由 packages/db 的 surreal-governance-tx.test(真 SurrealDB)钉死;
 *  回落档(无端口)行为不变由既有 state.test(in-memory)钉死。 */

interface MockGovRepo extends ProductStateRepository {
  runGovernanceTransaction(hot: GovernanceHotSpec, cold: GovernanceColdSpec): Promise<ProductState>;
  calls: Array<{ hot: GovernanceHotSpec; cold: GovernanceColdSpec }>;
}

function createMockGovRepo(opts?: { fail?: boolean }): MockGovRepo {
  const inner = createInMemoryProductStateRepository();
  const calls: Array<{ hot: GovernanceHotSpec; cold: GovernanceColdSpec }> = [];
  return {
    getState: () => inner.getState(),
    resetState: () => inner.resetState(),
    replaceState: (s, o) => inner.replaceState(s, o),
    getInterviewSession: (id) => inner.getInterviewSession(id),
    calls,
    async runGovernanceTransaction(hot, cold) {
      calls.push({ hot, cold });
      // 失败模拟整体回滚:内存态一律不动(端口抛错前不应用任何变更),与真事务回滚语义一致。
      if (opts?.fail) throw new Error("injected governance tx failure (simulated rollback)");
      // 成功:把 hot 应用到内存态(getState 随之反映),与 resetState/replaceState 同 revision 语义。
      return hot.kind === "reset"
        ? inner.resetState()
        : inner.replaceState(hot.next, hot.expectedRevision !== undefined ? { expectedRevision: hot.expectedRevision } : undefined);
    },
  };
}

const coldRepos = () => ({
  rawMaterialRepository: createInMemoryRawMaterialRepository(),
  audioRepository: createInMemoryAudioRepository(),
  knowledgeIndexRepository: createInMemoryKnowledgeIndexRepository(),
});

async function buildServer(repo: ProductStateRepository) {
  const server = Fastify();
  await registerStateRoutes(server, repo, coldRepos());
  return server;
}

describe("R2b 治理路由 · M1 并发护栏经全局错误处理器映射成 409", () => {
  it("整状态写在治理在途期抛 GovernanceInFlightError(statusCode 409)→ HTTP 409(前端已有 409 重试)", async () => {
    // 模拟"治理在途"的仓库:replaceState 抛 GovernanceInFlightError(与 surreal 护栏同一异常)。
    const repo: ProductStateRepository = {
      ...createInMemoryProductStateRepository(),
      replaceState: () => { throw new GovernanceInFlightError(); },
    };
    const server = buildApiServer({ productStateRepository: repo });
    const cur = (await server.inject({ method: "GET", url: "/api/state" })).json();
    // PUT 手动 revision 校验通过 → 进 replaceState → 抛 → 全局 setErrorHandler 按 statusCode=409 映射。
    const res = await server.inject({ method: "PUT", url: "/api/state", payload: { ...cur, revision: cur.revision } });
    expect(res.statusCode).toBe(409);
    await server.close();
  });
});

describe("R2b 治理路由 · 能力探测与 withKnowledgeReindex 透传", () => {
  it("asGovernanceTx 命中带 runGovernanceTransaction 的 repo;缺失则 undefined", () => {
    expect(asGovernanceTx(createMockGovRepo())).toBeDefined();
    expect(asGovernanceTx(createInMemoryProductStateRepository())).toBeUndefined();
  });

  it("withKnowledgeReindex 的 ...inner spread 保留 runGovernanceTransaction(生产路径 asGovernanceTx 可达)", () => {
    const wrapped = withKnowledgeReindex(createMockGovRepo(), createInMemoryKnowledgeIndexRepository(), () => undefined, createLlmBudget());
    expect(asGovernanceTx(wrapped)).toBeDefined();
  });
});

describe("R2b 治理路由 · 成功走真事务分支(reset/purge/import)", () => {
  it("reset:调 runGovernanceTransaction({kind:reset}, 三库 wipe)→ 200 + resetReceipt 全 cleared", async () => {
    const repo = createMockGovRepo();
    const server = await buildServer(repo);
    const res = await server.inject({ method: "POST", url: "/api/state/reset", payload: { confirm: "RESET_ALL_DATA" } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.resetReceipt).toEqual({ partialFailure: false, stores: { "raw-material": "cleared", audio: "cleared", "knowledge-index": "cleared" } });
    expect(repo.calls).toHaveLength(1);
    expect(repo.calls[0]!.hot).toEqual({ kind: "reset" });
    expect(repo.calls[0]!.cold).toEqual({ rawMaterial: { action: "wipe" }, audio: { action: "wipe" }, knowledgeIndex: { action: "wipe" } });
    await server.close();
  });

  it("purge(all):调 replace(purged) + 三库 wipe → 200 + purgeReceipt hotStateCommitted", async () => {
    const repo = createMockGovRepo();
    const server = await buildServer(repo);
    const res = await server.inject({ method: "POST", url: "/api/state/purge", payload: { confirm: "PURGE_PERSONAL_DATA" } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.deletedScope).toBe("all");
    expect(body.purgeReceipt).toEqual({ partialFailure: false, hotStateCommitted: true, stores: { "raw-material": "cleared", audio: "cleared", "knowledge-index": "cleared" } });
    expect(body.artifactPurge).toBeDefined();
    expect(repo.calls[0]!.hot.kind).toBe("replace");
    expect(repo.calls[0]!.cold).toEqual({ rawMaterial: { action: "wipe" }, audio: { action: "wipe" }, knowledgeIndex: { action: "wipe" } });
    await server.close();
  });

  it("purge(interviews):调 replace(scoped) + 三库 wipe → 200 + purgeReceipt", async () => {
    const repo = createMockGovRepo();
    const server = await buildServer(repo);
    const res = await server.inject({ method: "POST", url: "/api/state/purge", payload: { confirm: "PURGE_PERSONAL_DATA", scope: "interviews" } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.deletedScope).toBe("interviews");
    expect(body.purgeReceipt.hotStateCommitted).toBe(true);
    expect(body.purgeReceipt.partialFailure).toBe(false);
    expect(repo.calls[0]!.cold.knowledgeIndex).toEqual({ action: "wipe" });
    await server.close();
  });

  it("import 完整包:调 replace(imported) + 冷层 raw/audio replace(知识不入事务)→ 200 + importReceipt", async () => {
    const repo = createMockGovRepo();
    const server = await buildServer(repo);
    const payload = {
      confirm: "REPLACE_ALL_STATE",
      state: { profile: { name: "恢复者" }, notes: [] },
      rawMaterials: [{ sessionId: "s1", turns: [], createdAt: "2026-06-21T00:00:00.000Z" }],
      audios: [{ sessionId: "s1", mime: "audio/webm", audioBase64: Buffer.from([1, 2, 3]).toString("base64") }],
      audioSessions: ["s1"],
    };
    const res = await server.inject({ method: "POST", url: "/api/state/import", payload });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.importReceipt.partial).toBe(false);
    expect(body.importReceipt.restored).toEqual({ rawMaterials: 1, audios: 1 });
    expect(repo.calls[0]!.hot.kind).toBe("replace");
    const cold = repo.calls[0]!.cold;
    expect(cold.rawMaterial).toEqual({ action: "replace", materials: expect.any(Array) });
    expect((cold.rawMaterial as { materials: unknown[] }).materials).toHaveLength(1);
    expect(cold.audio).toEqual({ action: "replace", audios: expect.any(Array) });
    expect(cold.knowledgeIndex).toBeUndefined(); // 知识不入事务(提交后 best-effort 重建)
    await server.close();
  });

  it("import legacy preserve-cold:冷层规格缺省(preserve),只替换热态", async () => {
    const repo = createMockGovRepo();
    const server = await buildServer(repo);
    const res = await server.inject({
      method: "POST",
      url: "/api/state/import",
      payload: { confirm: "REPLACE_ALL_STATE", state: { profile: { name: "旧备份" } }, coldLayerMode: "preserve-cold" },
    });
    expect(res.statusCode).toBe(200);
    const cold = repo.calls[0]!.cold;
    expect(cold.rawMaterial).toBeUndefined(); // preserve-cold → 不触碰冷层
    expect(cold.audio).toBeUndefined();
    await server.close();
  });
});

describe("R2b 治理路由 · 整体回滚 → 500 + 回执标注(无部分提交,不带 state)", () => {
  it("reset 事务失败 → 500 + resetReceipt rolled-back;不带 state(前端不采纳假清空);内存态未变", async () => {
    const repo = createMockGovRepo({ fail: true });
    const server = await buildServer(repo);
    // 先污染热态,证明失败后热态原样(未被"假清空")。
    const cur = (await server.inject({ method: "GET", url: "/api/state" })).json();
    await server.inject({ method: "PUT", url: "/api/state", payload: { ...cur, revision: cur.revision, profile: { ...cur.profile, name: "留存" } } });

    const res = await server.inject({ method: "POST", url: "/api/state/reset", payload: { confirm: "RESET_ALL_DATA" } });
    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body.rolledBack).toBe(true);
    expect(body.state).toBeUndefined(); // 关键:热态未提交,绝不回传可被前端采纳的"已清空"态
    expect(body.resetReceipt).toEqual({
      partialFailure: false, rolledBack: true, hotStateCommitted: false,
      stores: { "raw-material": "rolled-back", audio: "rolled-back", "knowledge-index": "rolled-back" },
    });
    const after = (await server.inject({ method: "GET", url: "/api/state" })).json();
    expect(after.profile.name).toBe("留存"); // 内存态原样(整体回滚)
    await server.close();
  });

  it("purge(all) 事务失败 → 500 + purgeReceipt rolled-back + artifactPurge;不带 state", async () => {
    const repo = createMockGovRepo({ fail: true });
    const server = await buildServer(repo);
    const res = await server.inject({ method: "POST", url: "/api/state/purge", payload: { confirm: "PURGE_PERSONAL_DATA" } });
    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body.rolledBack).toBe(true);
    expect(body.state).toBeUndefined();
    expect(body.artifactPurge).toBeDefined(); // 文件层非事务:如实带回
    expect(body.purgeReceipt).toEqual({
      partialFailure: false, rolledBack: true, hotStateCommitted: false,
      stores: { "raw-material": "rolled-back", audio: "rolled-back", "knowledge-index": "rolled-back" },
    });
    await server.close();
  });

  it("purge(interviews) 事务失败 → 500 + purgeReceipt rolled-back;不带 state", async () => {
    const repo = createMockGovRepo({ fail: true });
    const server = await buildServer(repo);
    const res = await server.inject({ method: "POST", url: "/api/state/purge", payload: { confirm: "PURGE_PERSONAL_DATA", scope: "interviews" } });
    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body.rolledBack).toBe(true);
    expect(body.state).toBeUndefined();
    expect(body.purgeReceipt.hotStateCommitted).toBe(false);
    await server.close();
  });

  it("import 事务失败 → 500 + failedStep:transaction + rolledBack + steps 全 rolled-back;不带 state", async () => {
    const repo = createMockGovRepo({ fail: true });
    const server = await buildServer(repo);
    const res = await server.inject({
      method: "POST",
      url: "/api/state/import",
      payload: {
        confirm: "REPLACE_ALL_STATE",
        state: { profile: { name: "恢复者" } },
        rawMaterials: [{ sessionId: "s1", turns: [], createdAt: "2026-06-21T00:00:00.000Z" }],
        audios: [],
      },
    });
    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body.failedStep).toBe("transaction");
    expect(body.rolledBack).toBe(true);
    expect(body.state).toBeUndefined();
    expect(body.steps).toEqual(
      expect.arrayContaining([
        { store: "raw-material", status: "rolled-back" },
        { store: "audio", status: "rolled-back" },
        { store: "hot-state", status: "rolled-back" },
      ])
    );
    await server.close();
  });
});
