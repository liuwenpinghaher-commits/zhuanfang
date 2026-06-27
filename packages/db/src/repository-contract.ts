import { expect, it } from "vitest";
import type { ProductStateRepository } from "../../../apps/api/src/product-state-repository";
import { StateRevisionConflictError } from "../../../apps/api/src/product-state-repository";

/** 三实现（in-memory/sqlite/surreal）共用的行为契约。makeRepo 每次返回一个全新空仓库。
 *  flush:surreal 这类异步落库实现传入,等待持久化;同步实现传 undefined。 */
export function runProductStateRepositoryContract(
  makeRepo: () => Promise<ProductStateRepository> | ProductStateRepository,
  flush?: (repo: ProductStateRepository) => Promise<void>
) {
  it("seed 后 getState 返回稳定初始态,revision 单调", async () => {
    const repo = await makeRepo();
    const s0 = repo.getState();
    expect(typeof s0.revision).toBe("number");
    const s1 = repo.replaceState(s0);
    expect(s1.revision).toBe((s0.revision ?? 0) + 1);
    const s2 = repo.replaceState(s1);
    expect(s2.revision).toBe(s1.revision + 1);
  });

  it("replaceState 写入的资产可被 getState 读回", async () => {
    const repo = await makeRepo();
    const base = repo.getState();
    const next = {
      ...base,
      points: [
        ...base.points,
        { id: "pt_contract_1", title: "标题", content: "内容", status: "稳定观点" as const,
          confidence: "用户确认" as const, evidence: ["e1"], relatedThemeIds: ["th_1"],
          important: true, updatedAt: "2026-06-27T00:00:00.000Z" }
      ]
    };
    repo.replaceState(next);
    const got = repo.getState().points.find((p) => p.id === "pt_contract_1");
    expect(got).toBeDefined();
    expect(got?.title).toBe("标题");
    expect(got?.relatedThemeIds).toEqual(["th_1"]); // rest 兜住的非核心字段也要无损
    expect(got?.evidence).toEqual(["e1"]);
  });

  it("expectedRevision 不符抛 StateRevisionConflictError", async () => {
    const repo = await makeRepo();
    const s = repo.getState();
    expect(() => repo.replaceState(s, { expectedRevision: (s.revision ?? 0) + 99 }))
      .toThrow(StateRevisionConflictError);
  });

  it("getInterviewSession 按 id 返回会话或 null", async () => {
    const repo = await makeRepo();
    const base = repo.getState();
    expect(repo.getInterviewSession("nope")).toBeNull();
    const session = base.sessions[0];
    if (session) expect(repo.getInterviewSession(session.id)?.id).toBe(session.id);
  });

  it("resetState 清空到空态", async () => {
    const repo = await makeRepo();
    const withData = { ...repo.getState(), points: [
      { id: "pt_x", title: "t", content: "c", status: "稳定观点" as const,
        confidence: "用户确认" as const, evidence: [], relatedThemeIds: [], important: false,
        updatedAt: "2026-06-27T00:00:00.000Z" }
    ] };
    repo.replaceState(withData);
    repo.resetState();
    expect(repo.getState().points).toHaveLength(0);
  });

  // 持久化重载（仅异步实现传 flush + reopenRepo;同步实现跳过）
  return { runReloadDurability(reopenRepo: () => Promise<ProductStateRepository>) {
    it("落库后重开仓库,状态无损重建", async () => {
      const repo = await makeRepo();
      const next = { ...repo.getState(), points: [
        { id: "pt_reload", title: "持久化", content: "c", status: "已修正" as const,
          confidence: "用户确认" as const, evidence: [], relatedThemeIds: ["th_r"], important: true,
          updatedAt: "2026-06-27T00:00:00.000Z" }
      ] };
      repo.replaceState(next);
      if (flush) await flush(repo);
      const reopened = await reopenRepo();
      const got = reopened.getState().points.find((p) => p.id === "pt_reload");
      expect(got?.relatedThemeIds).toEqual(["th_r"]);
    });
  } };
}
