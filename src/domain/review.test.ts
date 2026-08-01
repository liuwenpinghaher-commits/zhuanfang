import { describe, it, expect } from "vitest";
import { buildCognitiveRadar, buildMonthlyReview, buildYearlyReview } from "./review";
import { createInitialProductState } from "./engine";
import type { PointAsset, ProductState } from "./types";

function makePoint(overrides: Partial<PointAsset>): PointAsset {
  return {
    id: overrides.id ?? `p-${Math.random().toString(16).slice(2, 8)}`,
    title: overrides.title ?? "",
    content: overrides.content ?? "",
    status: overrides.status ?? "稳定观点",
    confidence: overrides.confidence ?? "用户确认",
    evidence: overrides.evidence ?? [],
    relatedThemeIds: overrides.relatedThemeIds ?? [],
    important: overrides.important ?? false,
    updatedAt: overrides.updatedAt ?? new Date().toISOString(),
  };
}

describe("buildMonthlyReview.changedView", () => {
  it("falls back to empty-state phrasing when there are no points", () => {
    const state = createInitialProductState();
    state.points = [];

    const review = buildMonthlyReview(state);

    expect(review.changedView).toBe("本月还没有形成正在变化的观点。");
  });

  it("describes the most recently corrected point", () => {
    const state = createInitialProductState();
    state.points = [
      makePoint({ title: "older", status: "已修正", content: "旧的修正", updatedAt: "2026-01-01T00:00:00.000Z" }),
      makePoint({ title: "newer", status: "已修正", content: "新的修正内容", updatedAt: "2026-06-01T00:00:00.000Z" }),
    ];

    const review = buildMonthlyReview(state);

    expect(review.changedView).toBe("已修正：新的修正内容");
  });

  it("describes a point currently being challenged", () => {
    const state = createInitialProductState();
    state.points = [
      makePoint({ title: "tension", status: "被挑战中", content: "团队是否真的需要每周复盘", updatedAt: "2026-06-10T00:00:00.000Z" }),
    ];

    const review = buildMonthlyReview(state);

    expect(review.changedView).toBe("正在被挑战：团队是否真的需要每周复盘");
  });

  it("falls back to title when content is empty", () => {
    const state = createInitialProductState();
    state.points = [
      makePoint({ title: "fallback-title", content: "", status: "已修正", updatedAt: "2026-06-10T00:00:00.000Z" }),
    ];

    const review = buildMonthlyReview(state);

    expect(review.changedView).toBe("已修正：fallback-title");
  });

  it("truncates summaries longer than 60 characters", () => {
    const longContent = "字".repeat(120);
    const state = createInitialProductState();
    state.points = [
      makePoint({ title: "long", status: "已修正", content: longContent, updatedAt: "2026-06-10T00:00:00.000Z" }),
    ];

    const review = buildMonthlyReview(state);

    // Verb prefix "已修正：" (4 chars) + 60 chars of content = 64 chars total.
    expect(review.changedView.length).toBe(4 + 60);
    expect(review.changedView.startsWith("已修正：")).toBe(true);
  });

  it("falls back to a stable point when no points are corrected or challenged", () => {
    const state = createInitialProductState();
    state.points = [
      makePoint({ title: "稳定观点A", status: "稳定观点" }),
    ];

    const review = buildMonthlyReview(state);

    expect(review.changedView).toBe("本月观点保持稳定：稳定观点A");
  });

  it("falls back to a count message when points exist but none are stable/corrected/challenged", () => {
    const state = createInitialProductState();
    state.points = [
      makePoint({ title: "tmp", status: "临时想法" }),
      makePoint({ title: "abandoned", status: "已放弃" }),
    ];

    const review = buildMonthlyReview(state);

    expect(review.changedView).toBe("本月共记录 2 条观点，尚未触发修正或挑战。");
  });
});

describe("buildCognitiveRadar honesty", () => {
  it("allows zero depth signals instead of fake floor values", () => {
    const state = createInitialProductState();
    state.notes = [];
    state.points = [];
    state.questions = [];
    state.themes = [];
    state.decisions = [];
    state.debts = [];

    const radar = buildCognitiveRadar(state);
    expect(radar.depth.every((item) => item.value === 0)).toBe(true);
    expect(radar.perspectives.find((item) => item.label === "系统论")?.value).toBe(0);
  });
});

describe("buildYearlyReview.changedViews fallback", () => {
  it("uses deriveChangedView output when no corrected/challenged titles exist", () => {
    const state: ProductState = createInitialProductState();
    state.points = [];

    const yearly = buildYearlyReview(state);

    expect(yearly.changedViews).toEqual(["本月还没有形成正在变化的观点。"]);
  });

  it("uses point titles when corrected/challenged titles are present", () => {
    const state = createInitialProductState();
    state.points = [
      makePoint({ title: "标题1", status: "已修正", content: "内容1" }),
      makePoint({ title: "标题2", status: "被挑战中", content: "内容2" }),
    ];

    const yearly = buildYearlyReview(state);

    expect(yearly.changedViews).toEqual(["标题1", "标题2"]);
  });
});
