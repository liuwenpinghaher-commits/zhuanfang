import { describe, it, expect } from "vitest";
import { buildApiServer, isWriteGateExempt } from "../server";
import {
  createInMemoryProductStateRepository,
  GovernanceInFlightError,
  type ProductStateRepository
} from "../product-state-repository";
import { createEmptyProductState, createInitialProductState } from "../../../../src/domain/engine";
import type { MemoryCandidate, ProductState } from "../../../../src/domain/types";
import type { BailianEmbeddingClient } from "../providers/bailian";

// ═══ R3 · 试点路由 CAS 换轨:全栈(buildApiServer)行为测试 ═══════════════════════════════
// 覆盖:①并发不同实体 → 双双成功且都落库(无丢失更新);②并发同一实体 → 确定性一胜一 409;
// ③治理在途 → 试点路由虽豁免写锁仍被 409 挡;④豁免名单判定(试点豁免/宽事务不豁免);
// ⑤D3 场景:长持锁写在途时,试点 handler 不排队(校验类 4xx 立即返回),但 CAS commit 经写门
//   排在其后 → 长写与试点写都不丢(丢失更新不可能性的行为级证据)。

function candidate(id: string, text: string): MemoryCandidate {
  return {
    id,
    text,
    status: "pending",
    sourceType: "interview_session",
    sourceId: "s1",
    evidenceQuote: "",
    reason: "测试种子",
    sensitivity: "normal",
    reviewScore: 0.5,
    reviewSignals: [],
    createdAt: "2026-07-11T00:00:00.000Z"
  };
}

function seedWithCandidates(ids: string[]): ProductState {
  return { ...createEmptyProductState(), memoryCandidates: ids.map((id) => candidate(id, `候选-${id}`)) };
}

describe("R3 试点路由 CAS 换轨(全栈)", () => {
  it("并发编辑两个不同候选 → 都 200 且都落库(无丢失更新)", async () => {
    const repo = createInMemoryProductStateRepository(seedWithCandidates(["c1", "c2"]));
    const server = buildApiServer({ productStateRepository: repo, env: {} });
    await server.ready();
    try {
      const [r1, r2] = await Promise.all([
        server.inject({ method: "PATCH", url: "/api/memory-candidates/c1", payload: { text: "新文本一" } }),
        server.inject({ method: "PATCH", url: "/api/memory-candidates/c2", payload: { text: "新文本二" } })
      ]);
      expect(r1.statusCode).toBe(200);
      expect(r2.statusCode).toBe(200);
      const finalState = repo.getState();
      // 关键断言:两笔写都存活——旧全局锁下靠排队保证,换轨后靠"CAS 尝试是门内连续同步块"保证
      expect(finalState.memoryCandidates.find((c) => c.id === "c1")?.text).toBe("新文本一");
      expect(finalState.memoryCandidates.find((c) => c.id === "c2")?.text).toBe("新文本二");
    } finally {
      await server.close();
    }
  });

  it("并发确认两个不同决策 → 都 200 且都确认", async () => {
    const base = createInitialProductState();
    const template = base.decisions.find((d) => d.confirmationStatus === "待用户确认");
    expect(template).toBeDefined(); // 前置:demo 态至少一条待确认决策,克隆出第二条
    const initial: ProductState = {
      ...base,
      decisions: [...base.decisions, { ...template!, id: `${template!.id}-r3-clone` }]
    };
    const pending = initial.decisions.filter((d) => d.confirmationStatus === "待用户确认");
    const repo = createInMemoryProductStateRepository(initial);
    const server = buildApiServer({ productStateRepository: repo, env: {} });
    await server.ready();
    try {
      const [a, b] = pending.slice(0, 2);
      const [r1, r2] = await Promise.all([
        server.inject({ method: "POST", url: `/api/assets/decisions/${a!.id}/confirm` }),
        server.inject({ method: "POST", url: `/api/assets/decisions/${b!.id}/confirm` })
      ]);
      expect(r1.statusCode).toBe(200);
      expect(r2.statusCode).toBe(200);
      const finalState = repo.getState();
      expect(finalState.decisions.find((d) => d.id === a!.id)?.confirmationStatus).toBe("用户确认");
      expect(finalState.decisions.find((d) => d.id === b!.id)?.confirmationStatus).toBe("用户确认");
    } finally {
      await server.close();
    }
  });

  it("并发确认【同一】决策 → 确定性一胜一 409(前置校验在 CAS 内基于最新态重算)", async () => {
    const initial = createInitialProductState();
    const target = initial.decisions.find((d) => d.confirmationStatus === "待用户确认");
    expect(target).toBeDefined();
    const repo = createInMemoryProductStateRepository(initial);
    const server = buildApiServer({ productStateRepository: repo, env: {} });
    await server.ready();
    try {
      const [r1, r2] = await Promise.all([
        server.inject({ method: "POST", url: `/api/assets/decisions/${target!.id}/confirm` }),
        server.inject({ method: "POST", url: `/api/assets/decisions/${target!.id}/confirm` })
      ]);
      const codes = [r1.statusCode, r2.statusCode].sort();
      expect(codes).toEqual([200, 409]); // 契约:恰好一胜一败,绝不双 200(掩盖)也不双 409(卡死)
      expect(repo.getState().decisions.find((d) => d.id === target!.id)?.confirmationStatus).toBe("用户确认");
    } finally {
      await server.close();
    }
  });

  it("治理在途:试点路由虽豁免全局写锁,仍被 GovernanceInFlightError 挡成 409", async () => {
    const inner = createInMemoryProductStateRepository(seedWithCandidates(["c1"]));
    // 模拟 surreal 档治理事务在途:任何整状态写被拒(R2b 语义)。
    const governed: ProductStateRepository = {
      ...inner,
      getState: () => inner.getState(),
      replaceState() {
        throw new GovernanceInFlightError();
      }
    };
    const server = buildApiServer({ productStateRepository: governed, env: {} });
    await server.ready();
    try {
      const res = await server.inject({
        method: "PATCH",
        url: "/api/memory-candidates/c1",
        payload: { text: "治理期间的编辑" }
      });
      expect(res.statusCode).toBe(409); // GovernanceInFlightError.statusCode → 全局 handler 映射
      expect(res.json().error).toContain("governance");
      expect(inner.getState().memoryCandidates[0]!.text).toBe("候选-c1"); // 未写入
    } finally {
      await server.close();
    }
  });

  it("豁免名单:试点路由豁免;宽事务(整包 PUT//end/治理/approve/consolidate)不豁免", () => {
    // 试点(豁免)
    expect(isWriteGateExempt("POST", "/api/assets/decisions/d1/confirm")).toBe(true);
    expect(isWriteGateExempt("POST", "/api/playbook-patches/p1/apply")).toBe(true);
    expect(isWriteGateExempt("POST", "/api/playbook-patches/p1/revert")).toBe(true);
    expect(isWriteGateExempt("PATCH", "/api/memory-records/m1")).toBe(true);
    expect(isWriteGateExempt("DELETE", "/api/memory-records/m1")).toBe(true);
    expect(isWriteGateExempt("POST", "/api/memory-records/m1/deprecate")).toBe(true);
    expect(isWriteGateExempt("PATCH", "/api/memory-candidates/c1")).toBe(true);
    expect(isWriteGateExempt("POST", "/api/memory-candidates/c1/reject")).toBe(true);
    expect(isWriteGateExempt("POST", "/api/research/auto-run")).toBe(true); // 既有豁免保持
    expect(isWriteGateExempt("PATCH", "/api/memory-candidates/c1?x=1")).toBe(true); // querystring 剥离
    // 宽事务/临界区有外部 IO(不豁免,整段持锁)
    expect(isWriteGateExempt("PUT", "/api/state")).toBe(false);
    expect(isWriteGateExempt("POST", "/api/state/reset")).toBe(false);
    expect(isWriteGateExempt("POST", "/api/state/purge")).toBe(false);
    expect(isWriteGateExempt("POST", "/api/state/import")).toBe(false);
    expect(isWriteGateExempt("POST", "/api/interview-sessions/s1/end")).toBe(false);
    expect(isWriteGateExempt("POST", "/api/interview-sessions/s1/turns")).toBe(false);
    expect(isWriteGateExempt("POST", "/api/memory-candidates/c1/approve")).toBe(false); // embed 在临界区
    expect(isWriteGateExempt("POST", "/api/memory/consolidate")).toBe(false); // LLM 在临界区
  });

  it("D3 场景:长持锁写在途——试点 handler 不排队(422 立即返回),有效写经写门排后、两笔都不丢", async () => {
    const repo = createInMemoryProductStateRepository(seedWithCandidates(["c1"]));
    // 可控悬挂的 embedding client:让 POST /api/interview-sessions(锁内路由)在"读态之后、
    // 写态之前"挂起 —— 精确复刻 D3 反向 clobber 的读写窗口。
    let releaseEmbed!: (v: number[][]) => void;
    const hangingEmbed = new Promise<number[][]>((resolve) => {
      releaseEmbed = resolve;
    });
    const embeddingClient = {
      providerId: "hanging-test",
      embed: () => hangingEmbed
    } as unknown as BailianEmbeddingClient;
    const server = buildApiServer({ productStateRepository: repo, env: {}, embeddingClient });
    await server.ready();
    try {
      // ① 锁内长写启动:占住全局写 slot,并停在 await embed 的读写窗口中间。
      const longWrite = server.inject({ method: "POST", url: "/api/interview-sessions", payload: {} });
      await new Promise((r) => setTimeout(r, 30)); // 让 preHandler 拿到 slot 并推进到 await embed

      // ② 试点路由的【校验类失败】不排队:空 text→422,在长写仍挂着时立即返回。
      //    (旧全局锁下该请求会被 preHandler 排到长写之后——这正是豁免带来的可观测差异。)
      const invalid = await Promise.race([
        server.inject({ method: "PATCH", url: "/api/memory-candidates/c1", payload: {} }).then((r) => r.statusCode),
        new Promise<string>((r) => setTimeout(() => r("timeout"), 500))
      ]);
      expect(invalid).toBe(422);

      // ③ 试点路由的【有效写】发出:其 CAS commit 经写门排在长写之后(D3 不变量),暂不完成。
      const validWrite = server.inject({ method: "PATCH", url: "/api/memory-candidates/c1", payload: { text: "窗口期编辑" } });
      let validSettled = false;
      void validWrite.then(() => {
        validSettled = true;
      });
      await new Promise((r) => setTimeout(r, 50));
      expect(validSettled).toBe(false); // commit 没有裸落进长写的读写窗口中间

      // ④ 放行长写 → 两笔按序落库,谁都不丢:会话创建(长写)与候选编辑(试点写)同时存活。
      releaseEmbed([[0.1, 0.2]]);
      const [longRes, validRes] = await Promise.all([longWrite, validWrite]);
      expect(longRes.statusCode).toBe(200);
      expect(validRes.statusCode).toBe(200);
      const finalState = repo.getState();
      expect(finalState.sessions.length).toBe(1); // 长写的成果在
      expect(finalState.memoryCandidates[0]!.text).toBe("窗口期编辑"); // 试点写的成果也在(未被整态回滚)
    } finally {
      await server.close();
    }
  });
});
