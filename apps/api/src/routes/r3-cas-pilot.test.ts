import { describe, it, expect } from "vitest";
import { buildApiServer, isWriteGateExempt, WRITE_SLOT_MAX_HOLD_MS, END_WRITE_PHASE_BUDGET_MS } from "../server";
import { MEMORY_EXTRACT_TIMEOUT_MS } from "../intelligence/memory-extraction-llm";
import { FINALIZE_TIMEOUT_MS } from "../intelligence/finalize-llm";
import { COGNITIVE_RELATIONS_TIMEOUT_MS } from "../intelligence/cognitive-relations-llm";
import { END_EMBED_PHASE_MS, WRITE_SLOT_HOLD_SLACK_MS } from "../server/write-gate";
import {
  createInMemoryProductStateRepository,
  GovernanceInFlightError,
  type ProductStateRepository
} from "../product-state-repository";
import { StateRevisionConflictError } from "../product-state-repository";
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

  it("CAS 耗尽 → 全局 handler 按 instanceof 映射 409(M2:helper 不再 per-throw 打 statusCode)", async () => {
    // repo 的 replaceState 恒抛 StateRevisionConflictError → runStateCommand 重试耗尽后原样上抛,
    // 到达全局 setErrorHandler 被 instanceof 分支映射成 409。证明 M2 的映射下沉端到端成立。
    const inner = createInMemoryProductStateRepository(seedWithCandidates(["c1"]));
    const alwaysConflict: ProductStateRepository = {
      ...inner,
      getState: () => inner.getState(),
      replaceState() {
        throw new StateRevisionConflictError(1, 999);
      }
    };
    const server = buildApiServer({ productStateRepository: alwaysConflict, env: {} });
    await server.ready();
    try {
      const res = await server.inject({ method: "PATCH", url: "/api/memory-candidates/c1", payload: { text: "改后" } });
      expect(res.statusCode).toBe(409); // 不是 500——全局 handler 识别 StateRevisionConflictError
      expect(res.json().error).toContain("revision");
    } finally {
      await server.close();
    }
  });

  it("P3-10:持锁上限须盖过 /end 最长合法写预算(强放余量 >0,不变量不再只活在注释)", () => {
    // invariant:sum(/end 各阶段超时) ≤ 持锁上限。否则合法长写会被强放,以旧基整态覆盖窗口内并发写
    // (反向 clobber)。此前只有注释口头保证;这里钉死,预算上调越界即红。
    expect(END_WRITE_PHASE_BUDGET_MS).toBe(
      MEMORY_EXTRACT_TIMEOUT_MS + FINALIZE_TIMEOUT_MS + COGNITIVE_RELATIONS_TIMEOUT_MS + 2 * END_EMBED_PHASE_MS
    );
    expect(WRITE_SLOT_MAX_HOLD_MS).toBeGreaterThanOrEqual(END_WRITE_PHASE_BUDGET_MS);
    expect(WRITE_SLOT_MAX_HOLD_MS - END_WRITE_PHASE_BUDGET_MS).toBeGreaterThanOrEqual(WRITE_SLOT_HOLD_SLACK_MS);
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
    // Long-holder remains create-session embed and /end. Login and /turns no longer hold the slot.
    expect(isWriteGateExempt("POST", "/api/interview-sessions/s1/end")).toBe(false);
    expect(isWriteGateExempt("POST", "/api/auth/login")).toBe(true);
    expect(isWriteGateExempt("POST", "/api/auth/logout")).toBe(true);
    expect(isWriteGateExempt("POST", "/api/interview-sessions/s1/turns")).toBe(true);
    expect(isWriteGateExempt("POST", "/api/interview-sessions/s1/turns/stream")).toBe(true);
    expect(isWriteGateExempt("POST", "/api/interview-sessions/s1/turns/cancel")).toBe(true);
    expect(isWriteGateExempt("POST", "/api/interview-sessions/s1/turns/extra")).toBe(false);
    expect(isWriteGateExempt("POST", "/api/memory-candidates/c1/approve")).toBe(false); // embed 在临界区
    expect(isWriteGateExempt("POST", "/api/memory/consolidate")).toBe(false); // LLM 在临界区
    // P3-17:声纹注册/删除、构建语音指令——无 state 终写(纯外呼/嵌入),已豁免免整段持锁。
    expect(isWriteGateExempt("POST", "/api/realtime-voice/voices")).toBe(true);
    expect(isWriteGateExempt("DELETE", "/api/realtime-voice/voices/v1")).toBe(true);
    expect(isWriteGateExempt("POST", "/api/interview-sessions/s1/voice-instructions")).toBe(true);
    // SR/IM-P1-03: long-IO routes exempt; final write via writeGate.runExclusive
    expect(isWriteGateExempt("POST", "/api/search/briefs")).toBe(true);
    expect(isWriteGateExempt("POST", "/api/search/briefs/b1/refresh")).toBe(true);
    expect(isWriteGateExempt("POST", "/api/import/documents")).toBe(true);
    expect(isWriteGateExempt("POST", "/api/chat")).toBe(true);
    // 同前缀 /end 仍整段持锁（宽事务）。/turns 已豁免，终写走 CAS。
    expect(isWriteGateExempt("POST", "/api/interview-sessions/s1/end")).toBe(false);
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

// ═══ R3(I1)· 豁免 CAS 路由的 writeGate 接线 × 8 参数化守卫 ══════════════════════════════
// 动机:豁免表↔路由 CAS↔注册传 writeGate 是三向约定,任一处静默漏配(尤其"注册时漏传
// writeGate")都会让该路由的 commit 绕过全局写门、裸落进长持锁写的读写窗口 → 无声反向 clobber
// (最隐蔽的失败模式)。此测试对每条豁免 CAS 路由构造 D3 窗口,断言其 commit【确实经写门序列化】:
//   构造:用 topicHint 携哨兵的 create-session 长写在 embed 处永久挂起、持有全局写 slot;
//   ①有效写不排队进 handler,但其 CAS commit 必须【卡在写门后】(长写释放前不 settle)——
//     若漏传 writeGate,commit 会在长写挂起期间裸执行、提前 settle → 本断言变红;
//   ②放行长写后,长写(整态 replaceState 无 expectedRevision)与试点写【双双存活】——
//     若漏传 writeGate,长写 resume 会以读时旧基整态回滚掉试点写 → 落库校验变红。
// 两道断言正交,任一命中即证明"漏传 writeGate→绕门 clobber"。哨兵只让 create-session 的 topic
// embed 挂起;试点路由自身若有 embed(PATCH 记忆记录),其文本不含哨兵 → 即时 resolve,不受影响。

const HANG_SENTINEL = "R3_D3_HANG_SENTINEL";

function memoryRecord(id: string, text: string) {
  return {
    id,
    text,
    status: "confirmed" as const,
    sourceType: "interview_session" as const,
    sourceId: "s1",
    evidenceQuote: "",
    sensitivity: "normal" as const,
    createdAt: "2026-07-11T00:00:00.000Z",
    updatedAt: "2026-07-11T00:00:00.000Z"
  };
}

function playbookPatch(id: string, status: "proposed" | "applied") {
  return {
    id,
    title: "先索要具体时刻",
    description: "抽象评价先落到具体事件",
    sourceInsightId: "insight-1",
    status,
    rules: ["当用户使用抽象评价时，先追问一个具体时刻。"],
    ruleTypes: ["concrete-moment" as const],
    impact: "medium" as const,
    createdAt: "2026-06-01T00:00:00.000Z",
    ...(status === "applied" ? { appliedAt: "2026-06-19T00:00:00.000Z" } : {})
  };
}

interface WiringCase {
  label: string;
  build: () => ProductState;
  method: "POST" | "PATCH" | "DELETE";
  url: string;
  payload?: unknown;
  /** 断言试点写的成果确实落库(未被长写整态回滚)。 */
  verify: (state: ProductState) => void;
}

function buildWiringCases(): WiringCase[] {
  const cases: WiringCase[] = [];

  // 1. 决策确认(createInitialProductState 自带待确认决策)
  {
    const state = createInitialProductState();
    const decision = state.decisions.find((d) => d.confirmationStatus === "待用户确认")!;
    cases.push({
      label: "POST /api/assets/decisions/:id/confirm",
      build: () => createInitialProductState(),
      method: "POST",
      url: `/api/assets/decisions/${decision.id}/confirm`,
      verify: (s) => expect(s.decisions.find((d) => d.id === decision.id)?.confirmationStatus).toBe("用户确认")
    });
  }
  // 2. playbook apply(proposed → applied)
  cases.push({
    label: "POST /api/playbook-patches/:id/apply",
    build: () => ({ ...createEmptyProductState(), playbookPatches: [playbookPatch("r3-patch-proposed", "proposed")] }),
    method: "POST",
    url: "/api/playbook-patches/r3-patch-proposed/apply",
    verify: (s) => expect(s.playbookPatches.find((p) => p.id === "r3-patch-proposed")?.status).toBe("applied")
  });
  // 3. playbook revert(applied → reverted)
  cases.push({
    label: "POST /api/playbook-patches/:id/revert",
    build: () => ({ ...createEmptyProductState(), playbookPatches: [playbookPatch("r3-patch-applied", "applied")] }),
    method: "POST",
    url: "/api/playbook-patches/r3-patch-applied/revert",
    verify: (s) => expect(s.playbookPatches.find((p) => p.id === "r3-patch-applied")?.status).toBe("reverted")
  });
  // 4. PATCH 记忆记录(带 embed:文本无哨兵 → 即时 resolve,commit 仍须经门)
  cases.push({
    label: "PATCH /api/memory-records/:id",
    build: () => ({ ...createEmptyProductState(), memoryRecords: [memoryRecord("r3-rec", "旧记忆")] }),
    method: "PATCH",
    url: "/api/memory-records/r3-rec",
    payload: { text: "改后记忆" },
    verify: (s) => expect(s.memoryRecords.find((r) => r.id === "r3-rec")?.text).toBe("改后记忆")
  });
  // 5. DELETE 记忆记录
  cases.push({
    label: "DELETE /api/memory-records/:id",
    build: () => ({ ...createEmptyProductState(), memoryRecords: [memoryRecord("r3-rec-del", "待删")] }),
    method: "DELETE",
    url: "/api/memory-records/r3-rec-del",
    verify: (s) => expect(s.memoryRecords.find((r) => r.id === "r3-rec-del")).toBeUndefined()
  });
  // 6. 废弃记忆记录(confirmed → deprecated)
  cases.push({
    label: "POST /api/memory-records/:id/deprecate",
    build: () => ({ ...createEmptyProductState(), memoryRecords: [memoryRecord("r3-rec-dep", "待废弃")] }),
    method: "POST",
    url: "/api/memory-records/r3-rec-dep/deprecate",
    payload: { reason: "过时" },
    verify: (s) => expect(s.memoryRecords.find((r) => r.id === "r3-rec-dep")?.status).toBe("deprecated")
  });
  // 7. PATCH 记忆候选文本
  cases.push({
    label: "PATCH /api/memory-candidates/:id",
    build: () => seedWithCandidates(["r3-cand"]),
    method: "PATCH",
    url: "/api/memory-candidates/r3-cand",
    payload: { text: "改后候选" },
    verify: (s) => expect(s.memoryCandidates.find((c) => c.id === "r3-cand")?.text).toBe("改后候选")
  });
  // 8. 拒绝记忆候选(pending → rejected)
  cases.push({
    label: "POST /api/memory-candidates/:id/reject",
    build: () => seedWithCandidates(["r3-cand-rej"]),
    method: "POST",
    url: "/api/memory-candidates/r3-cand-rej/reject",
    payload: { reviewNote: "不采纳" },
    verify: (s) => expect(s.memoryCandidates.find((c) => c.id === "r3-cand-rej")?.status).toBe("rejected")
  });

  return cases;
}

describe("R3(I1)豁免 CAS 路由 × writeGate 接线守卫", () => {
  const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

  for (const c of buildWiringCases()) {
    it(`${c.label} 的 CAS commit 经写门序列化(漏传 writeGate 即变红)`, async () => {
      const repo = createInMemoryProductStateRepository(c.build());
      // 哨兵 embedding client:仅 create-session 的 topic(含哨兵)挂起并持锁;其余 embed 即时 resolve。
      let releaseHang!: (v: number[][]) => void;
      const hang = new Promise<number[][]>((resolve) => {
        releaseHang = resolve;
      });
      const embeddingClient = {
        providerId: "d3-wiring-test",
        embed: (texts: string[]) =>
          texts.some((t) => t.includes(HANG_SENTINEL)) ? hang : Promise.resolve(texts.map(() => [0.1, 0.2]))
      } as unknown as BailianEmbeddingClient;
      const server = buildApiServer({ productStateRepository: repo, env: {}, embeddingClient });
      await server.ready();
      try {
        // ① 锁内长写(create-session,topicHint 携哨兵)抓住全局写 slot 并在 embed 处永久挂起。
        const longWrite = server.inject({ method: "POST", url: "/api/interview-sessions", payload: { topicHint: HANG_SENTINEL } });
        await tick(30); // 让 preHandler 拿到 slot 并推进到 await embed

        // ② 试点有效写:handler 不排队(豁免),但其 CAS commit 必须卡在写门后 → 长写释放前不 settle。
        const pilotWrite = server.inject({ method: c.method, url: c.url, payload: c.payload as never });
        let settled = false;
        void pilotWrite.then(() => {
          settled = true;
        });
        await tick(60);
        expect(settled).toBe(false); // ★漏传 writeGate → commit 裸执行提前 settle,此断言变红

        // ③ 放行长写 → 长写(整态无 expectedRevision)与试点写双双存活(无反向 clobber)。
        releaseHang([[0.1, 0.2]]);
        const [longRes, pilotRes] = await Promise.all([longWrite, pilotWrite]);
        expect(longRes.statusCode).toBe(200);
        expect(pilotRes.statusCode).toBe(200);
        const finalState = repo.getState();
        expect(finalState.sessions.length).toBe(1); // 长写成果在
        c.verify(finalState); // ★漏传 writeGate → 长写 resume 整态回滚试点写,此断言变红
      } finally {
        await server.close();
      }
    });
  }
});

// N-13:apply 路由接线前端后支持"用户编辑后的规则集"(EditablePatchCard 可改 rules 再应用)。
describe("N-13 playbook apply overrideRules 透传", () => {
  it("body.overrideRules 非空 → 用编辑后的规则替换补丁原始规则(去空白/去空条)", async () => {
    const repo = createInMemoryProductStateRepository({
      ...createEmptyProductState(),
      playbookPatches: [playbookPatch("p-ovr", "proposed")]
    });
    const server = buildApiServer({ productStateRepository: repo, env: {} });
    const res = await server.inject({
      method: "POST",
      url: "/api/playbook-patches/p-ovr/apply",
      headers: { "content-type": "application/json" },
      payload: { overrideRules: ["改后规则A", "  改后规则B  ", "  "] }
    });
    expect(res.statusCode).toBe(200);
    const patch = repo.getState().playbookPatches.find((p) => p.id === "p-ovr");
    expect(patch?.status).toBe("applied");
    expect(patch?.rules).toEqual(["改后规则A", "改后规则B"]);
    await server.close();
  });

  it("无 body / 无 overrideRules → 保留补丁原始规则", async () => {
    const repo = createInMemoryProductStateRepository({
      ...createEmptyProductState(),
      playbookPatches: [playbookPatch("p-orig", "proposed")]
    });
    const server = buildApiServer({ productStateRepository: repo, env: {} });
    const res = await server.inject({ method: "POST", url: "/api/playbook-patches/p-orig/apply" });
    expect(res.statusCode).toBe(200);
    const patch = repo.getState().playbookPatches.find((p) => p.id === "p-orig");
    expect(patch?.rules).toEqual(["当用户使用抽象评价时，先追问一个具体时刻。"]);
    await server.close();
  });
});
