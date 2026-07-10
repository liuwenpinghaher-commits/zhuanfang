// F-05 离线重连保护的合并语义与退避序列测试。
// App.tsx 没有组件级测试基建，这里至少用纯函数把三方合并语义、冲突去重
// 和 autosave 重试节奏钉死，防止未来改动悄悄退化回"远端无条件覆盖本地"。
// (F-05 补审查 I-3:decideInitialSync 已随死代码删除,对应测试一并移除;
// mount 决策现走 outbox 三方合并路径,由下方 reconcileOfflineOutbox 系列钉住。)
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyProductState } from "./engine";
import type { AuditEvent, ProductState } from "./types";
import {
  mergeProductStates,
  nextBackoffMs,
  readOfflineOutbox,
  reconcileOfflineOutbox,
  upsertOfflineOutbox
} from "./offline-sync";

function auditEvent(id: string, label: string): AuditEvent {
  return {
    id,
    type: "profile_updated",
    label,
    detail: label,
    severity: "info",
    entityType: "user_profile",
    entityId: "local-product-state",
    createdAt: `2026-07-10T00:00:0${id.length}.000Z`
  };
}

function stateWithRevision(revision: number): ProductState {
  return { ...createEmptyProductState(), revision };
}

describe("nextBackoffMs (autosave 重试退避)", () => {
  it("按 5s 起步、×2 递增、封顶 60s", () => {
    expect(nextBackoffMs(1)).toBe(5_000);
    expect(nextBackoffMs(2)).toBe(10_000);
    expect(nextBackoffMs(3)).toBe(20_000);
    expect(nextBackoffMs(4)).toBe(40_000);
    expect(nextBackoffMs(5)).toBe(60_000);
    expect(nextBackoffMs(6)).toBe(60_000);
    expect(nextBackoffMs(100)).toBe(60_000);
  });

  it("非法输入（<1 / 非整数）不产出异常间隔", () => {
    expect(nextBackoffMs(0)).toBe(5_000);
    expect(nextBackoffMs(-3)).toBe(5_000);
    expect(nextBackoffMs(2.7)).toBe(10_000);
    expect(nextBackoffMs(Number.MAX_SAFE_INTEGER)).toBe(60_000);
  });
});

describe("mergeProductStates (F-05 三方合并)", () => {
  it("自动合并不同字段与不同 id 实体的双端修改，并沿用远端 revision", () => {
    const base = stateWithRevision(4);
    const local = {
      ...base,
      profile: { ...base.profile, currentFocus: "本地离线编辑" },
      auditEvents: [auditEvent("local", "本地事件")]
    };
    const remote = {
      ...base,
      revision: 7,
      profile: { ...base.profile, longTermGoal: "服务端新增目标" },
      auditEvents: [auditEvent("remote", "服务端事件")]
    };

    const result = mergeProductStates(base, local, remote);

    expect(result.conflicts).toEqual([]);
    expect(result.state.revision).toBe(7);
    expect(result.state.profile.currentFocus).toBe("本地离线编辑");
    expect(result.state.profile.longTermGoal).toBe("服务端新增目标");
    expect(result.state.auditEvents.map((event) => event.id)).toEqual(
      expect.arrayContaining(["local", "remote"])
    );
  });

  it("同一叶子字段被双端改成不同值时产生可恢复冲突，不静默采用任一端", () => {
    const base = stateWithRevision(2);
    const local = { ...base, profile: { ...base.profile, role: "本地角色" } };
    const remote = { ...base, revision: 3, profile: { ...base.profile, role: "服务端角色" } };

    const result = mergeProductStates(base, local, remote);

    expect(result.state.profile.role).toBe("本地角色");
    expect(result.conflicts).toEqual([
      {
        path: "profile.role",
        base: base.profile.role,
        local: "本地角色",
        remote: "服务端角色"
      }
    ]);
  });

  it("C-2 回归哨兵:merge(base=旧数据, local=空, remote=旧数据) → 无冲突输出空", () => {
    // 场景:网络失败的本地 reset 产生"local = 空态"。三方合并的语义只能把它理解成
    // "本地删除了一切、远端未变" → 合法单边删除,无冲突输出空态。也就是说,一旦让
    // reset 空态进入 outbox,重连后会被自动 PUT 成空库,静默绕过服务端冷层清理
    // (逐字稿/录音/知识索引残留却对用户显示"已清空")。
    // 这不是合并算法的 bug——"删除一切"与"用户离线清空回收站"在算法层不可区分,
    // 不能也不应在这里特判空态。防线必须是 App.resetData 网络失败分支的生命周期修复
    // (C-2:clearPendingSync + 三基线 ref 对齐空态,让空态根本不被 stage 进 outbox)。
    // 若本测试失败,说明有人试图在合并层"救回"数据——请先回看 C-2 的设计决策。
    const existing = auditEvent("legacy", "reset 前的既有数据");
    const base = { ...stateWithRevision(50), auditEvents: [existing] };
    const localEmptyReset = stateWithRevision(50);
    const remoteUnchanged = { ...base, revision: 51 };

    const result = mergeProductStates(base, localEmptyReset, remoteUnchanged);

    expect(result.conflicts).toEqual([]);
    expect(result.state.auditEvents).toEqual([]);
    expect(result.state.revision).toBe(51);
  });

  it("同一 id 实体一端删除、另一端修改时标记实体冲突并保留两端证据", () => {
    const original = auditEvent("shared", "原始事件");
    const base = { ...stateWithRevision(5), auditEvents: [original] };
    const local = { ...base, auditEvents: [] };
    const remoteUpdated = { ...original, label: "服务端改写" };
    const remote = { ...base, revision: 6, auditEvents: [remoteUpdated] };

    const result = mergeProductStates(base, local, remote);

    expect(result.state.auditEvents).toEqual([]);
    expect(result.conflicts).toEqual([
      {
        path: "auditEvents[shared]",
        base: original,
        local: undefined,
        remote: remoteUpdated
      }
    ]);
  });
});

describe("upsertOfflineOutbox (F-05 持久 outbox)", () => {
  it("首次记录 baseRevision/baseState，后续本地编辑只更新 localState、不漂移基线", () => {
    const base = stateWithRevision(11);
    const localV1 = { ...base, profile: { ...base.profile, currentFocus: "离线修改 1" } };
    const first = upsertOfflineOutbox({
      baseState: base,
      localState: localV1,
      now: "2026-07-10T01:00:00.000Z"
    });

    const accidentalNewBase = stateWithRevision(99);
    const localV2 = { ...localV1, profile: { ...localV1.profile, currentFocus: "离线修改 2" } };
    const second = upsertOfflineOutbox({
      existing: first,
      baseState: accidentalNewBase,
      localState: localV2,
      now: "2026-07-10T01:05:00.000Z"
    });

    expect(second.baseRevision).toBe(11);
    expect(second.baseState.revision).toBe(11);
    expect(second.localState.profile.currentFocus).toBe("离线修改 2");
    expect(second.createdAt).toBe("2026-07-10T01:00:00.000Z");
    expect(second.updatedAt).toBe("2026-07-10T01:05:00.000Z");
  });

  it("重开页面时保留上次未决冲突，不能因远端暂未变化而自动推送本地胜出值", () => {
    const base = stateWithRevision(20);
    const local = { ...base, profile: { ...base.profile, role: "本地角色" } };
    const remote = { ...base, revision: 21, profile: { ...base.profile, role: "服务端角色" } };
    const firstMerge = mergeProductStates(base, local, remote);
    const persisted = upsertOfflineOutbox({
      baseState: base,
      localState: local,
      conflicts: firstMerge.conflicts,
      now: "2026-07-10T02:00:00.000Z"
    });

    const reopened = reconcileOfflineOutbox(persisted, remote);

    expect(reopened.status).toBe("conflict");
    expect(reopened.conflicts).toEqual(firstMerge.conflicts);
    expect(reopened.state.profile.role).toBe("本地角色");
  });

  it("冲突未裁决时继续本地编辑，只刷新 localState，不得清掉 conflicts", () => {
    const base = stateWithRevision(30);
    const local = { ...base, profile: { ...base.profile, role: "本地角色" } };
    const remote = { ...base, revision: 31, profile: { ...base.profile, role: "服务端角色" } };
    const conflicts = mergeProductStates(base, local, remote).conflicts;
    const pending = upsertOfflineOutbox({ baseState: base, localState: local, conflicts });
    const editedAgain = {
      ...local,
      profile: { ...local.profile, currentFocus: "冲突期间继续写的内容" }
    };

    const refreshed = upsertOfflineOutbox({
      existing: pending,
      baseState: remote,
      localState: editedAgain
    });

    expect(refreshed.conflicts).toEqual(conflicts);
    expect(refreshed.localState.profile.currentFocus).toBe("冲突期间继续写的内容");
  });

  it("M-1:冲突未决期间继续编辑同一字段,conflicts 按 path 去重且 local 取最新,计数不虚高", () => {
    // 此前冲突身份把 local 值也算进去:每次编辑同一冲突字段都会追加一条"新"冲突,
    // UI 冲突计数持续膨胀。现按 path 去重——同一 path 只有一个待裁决问题。
    const base = stateWithRevision(40);
    const remote = { ...base, revision: 41, profile: { ...base.profile, role: "服务端角色" } };
    const firstLocal = { ...base, profile: { ...base.profile, role: "本地v1" } };
    const firstConflicts = mergeProductStates(base, firstLocal, remote).conflicts;
    expect(firstConflicts).toHaveLength(1);

    // 冲突未决期间用户又把同一字段改成 v2:outbox 带着旧冲突 + 新 localState 重放。
    const editedLocal = { ...base, profile: { ...base.profile, role: "本地v2" } };
    const pending = upsertOfflineOutbox({ baseState: base, localState: editedLocal, conflicts: firstConflicts });

    const reconciled = reconcileOfflineOutbox(pending, remote);

    expect(reconciled.status).toBe("conflict");
    expect(reconciled.conflicts).toHaveLength(1);
    expect(reconciled.conflicts[0]).toMatchObject({
      path: "profile.role",
      local: "本地v2",
      remote: "服务端角色"
    });
  });
});

describe("readOfflineOutbox (持久层健壮性)", () => {
  const OUTBOX_KEY = "interview-product-offline-outbox-v1";

  // 本套件的 jsdom 环境未提供可用的 localStorage(setItem 非函数),用内存 stub 注入
  // window——被测代码只依赖 getItem/setItem/removeItem 三个方法,语义等价且确定性更强。
  function stubWindowWithLocalStorage(initial: Record<string, string> = {}) {
    const store = new Map(Object.entries(initial));
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
        setItem: (key: string, value: string) => {
          store.set(key, String(value));
        },
        removeItem: (key: string) => {
          store.delete(key);
        }
      }
    });
    return store;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("坏 JSON → null 回退,不抛异常(I-4:钉住 localStorage 损坏时的启动路径)", () => {
    stubWindowWithLocalStorage({ [OUTBOX_KEY]: "{ 这不是合法 JSON" });
    expect(() => readOfflineOutbox()).not.toThrow();
    expect(readOfflineOutbox()).toBeNull();
  });

  it("合法 JSON 但形状不对(缺 baseState/localState 或版本不符) → null 回退", () => {
    stubWindowWithLocalStorage({
      [OUTBOX_KEY]: JSON.stringify({ version: 1, baseState: stateWithRevision(1) })
    });
    expect(readOfflineOutbox()).toBeNull();

    stubWindowWithLocalStorage({
      [OUTBOX_KEY]: JSON.stringify({ version: 2, baseState: stateWithRevision(1), localState: stateWithRevision(1) })
    });
    expect(readOfflineOutbox()).toBeNull();
  });

  it("完整 outbox 可无损读回(归一化后 base/local 与版本字段齐全)", () => {
    const base = stateWithRevision(7);
    const local = { ...base, profile: { ...base.profile, currentFocus: "离线修改" } };
    const outbox = upsertOfflineOutbox({ baseState: base, localState: local, now: "2026-07-10T03:00:00.000Z" });
    stubWindowWithLocalStorage({ [OUTBOX_KEY]: JSON.stringify(outbox) });

    const read = readOfflineOutbox();

    expect(read).not.toBeNull();
    expect(read?.baseRevision).toBe(7);
    expect(read?.localState.profile.currentFocus).toBe("离线修改");
    expect(read?.createdAt).toBe("2026-07-10T03:00:00.000Z");
  });
});
