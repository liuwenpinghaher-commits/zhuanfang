import { describe, it, expect, vi } from "vitest";
import { runStateCommand } from "./state-command";
import {
  createInMemoryProductStateRepository,
  GovernanceInFlightError,
  StateRevisionConflictError,
  type ProductStateRepository
} from "./product-state-repository";
import { createEmptyProductState } from "../../../src/domain/engine";
import type { ProductState } from "../../../src/domain/types";
import type { WriteGate } from "./server";

// R3:runStateCommand(应用层 CAS 重试命令)单元测试——成功 / 冲突重试 / 重试耗尽 409 /
// GovernanceInFlight 透传 / mutate null no-op / 写门经由。

function seedState(): ProductState {
  return { ...createEmptyProductState(), profile: { ...createEmptyProductState().profile, name: "初始" } };
}

/** 包一层仓库:前 failTimes 次 replaceState 抛 StateRevisionConflictError,之后放行(模拟并发抢写)。 */
function conflictNTimes(inner: ProductStateRepository, failTimes: number) {
  let failures = 0;
  const wrapped: ProductStateRepository = {
    ...inner,
    getState: () => inner.getState(),
    resetState: () => inner.resetState(),
    getInterviewSession: (id) => inner.getInterviewSession(id),
    replaceState(next, opts) {
      if (failures < failTimes) {
        failures += 1;
        // 模拟"别人抢先写了一笔":真把底层 state 推进一版,下轮重读能看到新基线。
        inner.replaceState(inner.getState());
        throw new StateRevisionConflictError(opts?.expectedRevision ?? -1, inner.getState().revision ?? 0);
      }
      return inner.replaceState(next, opts);
    }
  };
  return wrapped;
}

describe("runStateCommand(R3 CAS 重试)", () => {
  it("成功路径:mutate 应用、revision bump、携带 expectedRevision", () => {
    const inner = createInMemoryProductStateRepository(seedState());
    const replaceSpy = vi.spyOn(inner, "replaceState");
    const rev0 = inner.getState().revision ?? 0;
    return runStateCommand(inner, (state) => ({
      ...state,
      profile: { ...state.profile, name: "改后" }
    })).then((persisted) => {
      expect(persisted?.profile.name).toBe("改后");
      expect(persisted?.revision).toBe(rev0 + 1);
      // CAS 语义:必须携带读时快照的 revision 作乐观锁
      expect(replaceSpy).toHaveBeenCalledTimes(1);
      expect(replaceSpy.mock.calls[0]![1]).toEqual({ expectedRevision: rev0 });
    });
  });

  it("一次冲突后重试成功:mutate 第二轮拿到【最新】基线重算", async () => {
    const inner = createInMemoryProductStateRepository(seedState());
    const repo = conflictNTimes(inner, 1);
    const seenRevisions: number[] = [];
    const persisted = await runStateCommand(repo, (state) => {
      seenRevisions.push(state.revision ?? 0);
      return { ...state, profile: { ...state.profile, name: "重试后写入" } };
    });
    expect(persisted?.profile.name).toBe("重试后写入");
    expect(seenRevisions).toHaveLength(2);
    // 第二轮读到的基线必须比第一轮新(冲突方推进了一版)——证明"重读重算"而非拿旧基硬写
    expect(seenRevisions[1]!).toBeGreaterThan(seenRevisions[0]!);
  });

  it("重试耗尽:原样抛 StateRevisionConflictError(M2:不再 per-throw 打 statusCode,映射下沉全局 handler)", async () => {
    const inner = createInMemoryProductStateRepository(seedState());
    const repo = conflictNTimes(inner, 99); // 永远冲突
    const mutate = vi.fn((state: ProductState) => ({ ...state }));
    const err = await runStateCommand(repo, mutate, { maxRetries: 2 }).catch((e) => e);
    expect(err).toBeInstanceOf(StateRevisionConflictError);
    // M2:helper 不再在实例上打 statusCode——409 由 server.ts 全局 setErrorHandler 按 instanceof 映射
    // (全栈映射见 r3-cas-pilot.test.ts 的"CAS 耗尽 → 全局 handler 映射 409")。
    expect((err as { statusCode?: number }).statusCode).toBeUndefined();
    expect(mutate).toHaveBeenCalledTimes(3); // 1 首次 + 2 重试,有界
  });

  it("M4:maxRetries 负值被钳到 0(至少跑一次,不 NPE),耗尽抛 StateRevisionConflictError", async () => {
    const inner = createInMemoryProductStateRepository(seedState());
    const repo = conflictNTimes(inner, 99); // 永远冲突
    const mutate = vi.fn((state: ProductState) => ({ ...state }));
    const err = await runStateCommand(repo, mutate, { maxRetries: -5 }).catch((e) => e);
    expect(err).toBeInstanceOf(StateRevisionConflictError); // 不是 TypeError(undefined 解引用)
    expect(mutate).toHaveBeenCalledTimes(1); // 钳到 0 重试 = 仅首次一次
  });

  it("GovernanceInFlightError 直接透传,不重试", async () => {
    const inner = createInMemoryProductStateRepository(seedState());
    const repo: ProductStateRepository = {
      ...inner,
      getState: () => inner.getState(),
      replaceState() {
        throw new GovernanceInFlightError();
      }
    };
    const mutate = vi.fn((state: ProductState) => ({ ...state }));
    const err = await runStateCommand(repo, mutate).catch((e) => e);
    expect(err).toBeInstanceOf(GovernanceInFlightError);
    expect((err as GovernanceInFlightError).statusCode).toBe(409);
    expect(mutate).toHaveBeenCalledTimes(1); // 治理在途重试无意义,必须一次即抛
  });

  it("mutate 返回 null:no-op——不调 replaceState,原样返回 null(404 语义留给调用方)", async () => {
    const inner = createInMemoryProductStateRepository(seedState());
    const replaceSpy = vi.spyOn(inner, "replaceState");
    const result = await runStateCommand(inner, () => null);
    expect(result).toBeNull();
    expect(replaceSpy).not.toHaveBeenCalled();
  });

  it("传 writeGate 时:每次 CAS 尝试(读-算-写)都在写门内执行(D3 不变量)", async () => {
    const inner = createInMemoryProductStateRepository(seedState());
    const repo = conflictNTimes(inner, 1);
    const gateLabels: string[] = [];
    let mutateRanInsideGate = 0;
    let insideGate = false;
    const gate: WriteGate = {
      async runExclusive(label, fn) {
        gateLabels.push(label);
        insideGate = true;
        try {
          return await fn();
        } finally {
          insideGate = false;
        }
      }
    };
    const persisted = await runStateCommand(
      repo,
      (state) => {
        if (insideGate) mutateRanInsideGate += 1;
        return { ...state, profile: { ...state.profile, name: "门内" } };
      },
      { writeGate: gate, label: "command:test" }
    );
    expect(persisted?.profile.name).toBe("门内");
    expect(gateLabels).toEqual(["command:test", "command:test"]); // 冲突重试的每一轮都重新过门
    expect(mutateRanInsideGate).toBe(2); // 读-算-写全程在门内,不是只有写在门内
  });

  it("mutate 抛出的其它错误原样冒泡(不吞、不误标 409)", async () => {
    const inner = createInMemoryProductStateRepository(seedState());
    const boom = new Error("domain invariant broken");
    const err = await runStateCommand(inner, () => {
      throw boom;
    }).catch((e) => e);
    expect(err).toBe(boom);
    expect((err as { statusCode?: number }).statusCode).toBeUndefined();
  });
});
