import { describe, it, expect } from "vitest";
import { collectCandidatePointPairs, applyCognitiveRelations, type CognitiveRelations } from "./reasoning";
import { createInitialProductState } from "./engine";
import type { PointAsset, ProductState } from "./types";

function point(id: string, overrides: Partial<PointAsset> = {}): PointAsset {
  return {
    id,
    title: `观点 ${id}`,
    content: `内容 ${id}`,
    status: "临时想法",
    confidence: "AI 推断",
    evidence: [],
    relatedThemeIds: [],
    important: false,
    updatedAt: "2026-06-27T00:00:00.000Z",
    ...overrides
  };
}

function stateWith(points: PointAsset[]): ProductState {
  return { ...createInitialProductState(), points };
}

describe("collectCandidatePointPairs", () => {
  it("同主题、不同 id 的观点配成候选对", () => {
    const state = stateWith([
      point("pt_1", { relatedThemeIds: ["th_1"] }),
      point("pt_2", { relatedThemeIds: ["th_1"] }),
      point("pt_3", { relatedThemeIds: ["th_2"] })
    ]);
    const pairs = collectCandidatePointPairs(state);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].map((p) => p.id).sort()).toEqual(["pt_1", "pt_2"]);
  });

  it("不同主题的观点不配对", () => {
    const state = stateWith([
      point("pt_1", { relatedThemeIds: ["th_1"] }),
      point("pt_2", { relatedThemeIds: ["th_2"] })
    ]);
    expect(collectCandidatePointPairs(state)).toHaveLength(0);
  });

  it("无 relatedThemeIds 的观点不进候选", () => {
    const state = stateWith([point("pt_1"), point("pt_2")]);
    expect(collectCandidatePointPairs(state)).toHaveLength(0);
  });

  it("symmetric 去重:同一对只出现一次(即便共享多个主题)", () => {
    const state = stateWith([
      point("pt_1", { relatedThemeIds: ["th_1", "th_2"] }),
      point("pt_2", { relatedThemeIds: ["th_1", "th_2"] })
    ]);
    const pairs = collectCandidatePointPairs(state);
    expect(pairs).toHaveLength(1);
  });

  it("跳过已成关系的对(已 contradicts 或已 superseded),不重复送判", () => {
    const state = stateWith([
      point("pt_1", { relatedThemeIds: ["th_1"], contradictsPointIds: ["pt_2"] }),
      point("pt_2", { relatedThemeIds: ["th_1"] }),
      point("pt_3", { relatedThemeIds: ["th_1"], supersededByPointId: "pt_4" }),
      point("pt_4", { relatedThemeIds: ["th_1"] })
    ]);
    const pairs = collectCandidatePointPairs(state).map((pair) => pair.map((p) => p.id).sort().join("-"));
    // pt_1↔pt_2 已对立、pt_3↔pt_4 已修正 → 不再送判;其余跨组对仍可出现。
    expect(pairs).not.toContain("pt_1-pt_2");
    expect(pairs).not.toContain("pt_3-pt_4");
  });

  it("已放弃的观点不进候选(终态,不参与推理)", () => {
    const state = stateWith([
      point("pt_1", { relatedThemeIds: ["th_1"], status: "已放弃" }),
      point("pt_2", { relatedThemeIds: ["th_1"] })
    ]);
    expect(collectCandidatePointPairs(state)).toHaveLength(0);
  });

  it("候选对数量有上限(防组合爆炸)", () => {
    const many = Array.from({ length: 60 }, (_, i) => point(`pt_${i}`, { relatedThemeIds: ["th_1"] }));
    const pairs = collectCandidatePointPairs(stateWith(many));
    // 全配对是 60*59/2=1770;实现应封顶。这里断言不超过一个合理上限。
    expect(pairs.length).toBeLessThanOrEqual(200);
  });
});

describe("applyCognitiveRelations", () => {
  it("contradicts:双向写 contradictsPointIds + 较早一方置「被挑战中」", () => {
    const state = stateWith([
      point("pt_old", { relatedThemeIds: ["th_1"], updatedAt: "2026-06-01T00:00:00.000Z" }),
      point("pt_new", { relatedThemeIds: ["th_1"], updatedAt: "2026-06-20T00:00:00.000Z" })
    ]);
    const relations: CognitiveRelations = { contradicts: [["pt_old", "pt_new"]], supersedes: [] };
    const next = applyCognitiveRelations(state, relations);
    const old = next.points.find((p) => p.id === "pt_old")!;
    const fresh = next.points.find((p) => p.id === "pt_new")!;
    expect(old.contradictsPointIds).toContain("pt_new");
    expect(fresh.contradictsPointIds).toContain("pt_old");
    // 较早的一方被挑战。
    expect(old.status).toBe("被挑战中");
  });

  it("contradicts:contradictsPointIds 去重(重复 relation 不产生重复 id)", () => {
    const state = stateWith([
      point("pt_1", { relatedThemeIds: ["th_1"], contradictsPointIds: ["pt_2"] }),
      point("pt_2", { relatedThemeIds: ["th_1"] })
    ]);
    const next = applyCognitiveRelations(state, { contradicts: [["pt_1", "pt_2"]], supersedes: [] });
    const p1 = next.points.find((p) => p.id === "pt_1")!;
    expect(p1.contradictsPointIds).toEqual(["pt_2"]);
  });

  it("supersedes:旧观点 supersededByPointId=新 id + status「已修正」", () => {
    const state = stateWith([
      point("pt_old", { relatedThemeIds: ["th_1"] }),
      point("pt_new", { relatedThemeIds: ["th_1"] })
    ]);
    const next = applyCognitiveRelations(state, { contradicts: [], supersedes: [{ oldId: "pt_old", newId: "pt_new" }] });
    const old = next.points.find((p) => p.id === "pt_old")!;
    expect(old.supersededByPointId).toBe("pt_new");
    expect(old.status).toBe("已修正");
    // 新观点不被改动。
    expect(next.points.find((p) => p.id === "pt_new")!.supersededByPointId).toBeUndefined();
  });

  it("不可变更新:不修改入参 state", () => {
    const state = stateWith([
      point("pt_1", { relatedThemeIds: ["th_1"] }),
      point("pt_2", { relatedThemeIds: ["th_1"] })
    ]);
    const before = JSON.stringify(state);
    applyCognitiveRelations(state, { contradicts: [["pt_1", "pt_2"]], supersedes: [{ oldId: "pt_1", newId: "pt_2" }] });
    expect(JSON.stringify(state)).toBe(before);
  });

  it("忽略指向不存在 point 的关系(防悬挂)", () => {
    const state = stateWith([point("pt_1", { relatedThemeIds: ["th_1"] })]);
    const next = applyCognitiveRelations(state, {
      contradicts: [["pt_1", "pt_ghost"]],
      supersedes: [{ oldId: "pt_1", newId: "pt_ghost" }]
    });
    const p1 = next.points.find((p) => p.id === "pt_1")!;
    expect(p1.contradictsPointIds ?? []).not.toContain("pt_ghost");
    expect(p1.supersededByPointId).toBeUndefined();
  });

  it("空关系 → 原样返回(无副作用)", () => {
    const state = stateWith([point("pt_1", { relatedThemeIds: ["th_1"] })]);
    const next = applyCognitiveRelations(state, { contradicts: [], supersedes: [] });
    expect(next.points[0].status).toBe("临时想法");
    expect(next.points[0].contradictsPointIds).toBeUndefined();
  });

  it("C 守卫:两方都用户确认时,对立软链照写但谁都不被降级为被挑战中", () => {
    const state = stateWith([
      point("pt_a", { relatedThemeIds: ["th_1"], confidence: "用户确认", status: "稳定观点", updatedAt: "2026-06-01T00:00:00.000Z" }),
      point("pt_b", { relatedThemeIds: ["th_1"], confidence: "用户确认", status: "稳定观点", updatedAt: "2026-06-20T00:00:00.000Z" })
    ]);
    const next = applyCognitiveRelations(state, { contradicts: [["pt_a", "pt_b"]], supersedes: [] });
    expect(next.points.find((p) => p.id === "pt_a")!.contradictsPointIds).toContain("pt_b");
    // 用户确认是用户的明确立场,不被 LLM 对立判定降级。
    expect(next.points.find((p) => p.id === "pt_a")!.status).toBe("稳定观点");
    expect(next.points.find((p) => p.id === "pt_b")!.status).toBe("稳定观点");
  });

  it("C 守卫:用户确认的观点不被 supersede 自动作废", () => {
    const state = stateWith([
      point("pt_user", { relatedThemeIds: ["th_1"], confidence: "用户确认", status: "稳定观点", updatedAt: "2026-06-01T00:00:00.000Z" }),
      point("pt_new", { relatedThemeIds: ["th_1"], updatedAt: "2026-06-20T00:00:00.000Z" })
    ]);
    const next = applyCognitiveRelations(state, { contradicts: [], supersedes: [{ oldId: "pt_user", newId: "pt_new" }] });
    expect(next.points.find((p) => p.id === "pt_user")!.supersededByPointId).toBeUndefined();
    expect(next.points.find((p) => p.id === "pt_user")!.status).toBe("稳定观点");
  });

  it("H2 防倒流:取代方比被取代方更早时忽略该 supersede(不写时间倒流演化链)", () => {
    const state = stateWith([
      point("pt_old", { relatedThemeIds: ["th_1"], updatedAt: "2026-06-20T00:00:00.000Z" }), // 实际较新
      point("pt_new", { relatedThemeIds: ["th_1"], updatedAt: "2026-06-01T00:00:00.000Z" })  // 实际较早
    ]);
    const next = applyCognitiveRelations(state, { contradicts: [], supersedes: [{ oldId: "pt_old", newId: "pt_new" }] });
    expect(next.points.find((p) => p.id === "pt_old")!.supersededByPointId).toBeUndefined();
    expect(next.points.find((p) => p.id === "pt_old")!.status).not.toBe("已修正");
  });
});
