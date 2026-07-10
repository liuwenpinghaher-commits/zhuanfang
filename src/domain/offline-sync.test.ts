// F-05 离线重连保护的决策矩阵与退避序列测试。
// App.tsx 没有组件级测试基建，这里至少用纯函数把"重连后采纳谁"的
// 决策矩阵和 autosave 重试节奏钉死，防止未来改动悄悄退化回"远端无条件覆盖本地"。
import { describe, expect, it } from "vitest";
import { createEmptyProductState } from "./engine";
import type { AuditEvent, ProductState } from "./types";
import {
  decideInitialSync,
  mergeProductStates,
  nextBackoffMs,
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

describe("decideInitialSync (F-05 重连决策矩阵)", () => {
  it("无未同步标志 → 采纳远端（现行为，服务器是真相源）", () => {
    expect(
      decideInitialSync({ hasUnsynced: false, localSignature: "a", remoteSignature: "b" })
    ).toBe("adopt-remote");
    // 标志未置位时内容是否相同不影响决策
    expect(
      decideInitialSync({ hasUnsynced: false, localSignature: "a", remoteSignature: "a" })
    ).toBe("adopt-remote");
  });

  it("有标志且本地内容 ≠ 远端 → 本地优先推送", () => {
    expect(
      decideInitialSync({ hasUnsynced: true, localSignature: "local-edited", remoteSignature: "remote-old" })
    ).toBe("push-local");
  });

  it("有标志但内容相同 → 采纳远端并清标志（上次其实已同步成功）", () => {
    expect(
      decideInitialSync({ hasUnsynced: true, localSignature: "same", remoteSignature: "same" })
    ).toBe("adopt-remote-clear-flag");
  });
});

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
});
