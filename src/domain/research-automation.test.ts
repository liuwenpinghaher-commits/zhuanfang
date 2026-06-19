/**
 * TDD 测试：外部调研自动化的 domain 纯函数
 * - isSearchBriefStale: 新鲜度检测
 * - dedupeBriefSources: 跨简报来源去重
 * - planResearchAgendaRun: 编排研究计划
 */

import { describe, expect, it } from "vitest";
import type { SearchBrief, SourceHighlight, ProductState } from "./types";
import {
  isSearchBriefStale,
  dedupeBriefSources,
  planResearchAgendaRun,
} from "./research-automation";
import { initialProductState } from "./seed";

// ─── 测试工厂 ──────────────────────────────────────────────────────────────────

function makeSource(override: Partial<SourceHighlight> = {}): SourceHighlight {
  return {
    id: "src-1",
    title: "测试来源",
    url: "https://example.com/article",
    publisher: "Test Publisher",
    publishedAt: "2026-01-01T00:00:00.000Z",
    snippet: "测试摘要",
    relevanceScore: 0.9,
    usage: "topic-suggestion",
    ...override,
  };
}

function makeBrief(override: Partial<SearchBrief> = {}): SearchBrief {
  return {
    id: "brief-1",
    topic: "AI 产品商业化",
    provider: "local-demo",
    status: "ready",
    summary: "测试摘要",
    facts: [],
    controversies: [],
    opposingViews: [],
    interviewAngles: [],
    discussionTopics: [],
    sourceAngles: [],
    sources: [],
    sourceTrace: [],
    appliedToSessionIds: [],
    createdAt: "2026-06-01T00:00:00.000Z",
    tracked: false,
    ...override,
  };
}

// ─── isSearchBriefStale ──────────────────────────────────────────────────────

describe("isSearchBriefStale", () => {
  it("刚创建的简报不应判定为过期（0天）", () => {
    const now = "2026-06-19T12:00:00.000Z";
    const brief = makeBrief({ createdAt: now });
    expect(isSearchBriefStale(brief, now)).toBe(false);
  });

  it("createdAt 为 15 天前且无 lastRefreshedAt → 应判定为过期", () => {
    const brief = makeBrief({ createdAt: "2026-06-04T00:00:00.000Z" });
    const now = "2026-06-19T00:00:00.000Z";
    expect(isSearchBriefStale(brief, now)).toBe(true);
  });

  it("lastRefreshedAt 为今天 → 不应判定为过期（即使 createdAt 很旧）", () => {
    const now = "2026-06-19T12:00:00.000Z";
    const brief = makeBrief({
      createdAt: "2025-01-01T00:00:00.000Z",
      lastRefreshedAt: "2026-06-19T00:00:00.000Z",
    });
    expect(isSearchBriefStale(brief, now)).toBe(false);
  });

  it("createdAt 恰好在阈值边界（14 天）→ 不过期", () => {
    const brief = makeBrief({ createdAt: "2026-06-05T00:00:00.000Z" });
    const now = "2026-06-19T00:00:00.000Z";
    expect(isSearchBriefStale(brief, now)).toBe(false);
  });

  it("lastRefreshedAt 为 15 天前 → 应判定为过期（优先使用 lastRefreshedAt）", () => {
    const brief = makeBrief({
      createdAt: "2026-01-01T00:00:00.000Z",
      lastRefreshedAt: "2026-06-04T00:00:00.000Z",
    });
    const now = "2026-06-19T00:00:00.000Z";
    expect(isSearchBriefStale(brief, now)).toBe(true);
  });

  it("自定义 staleDays=7，8 天前创建 → 应判定为过期", () => {
    const brief = makeBrief({ createdAt: "2026-06-11T00:00:00.000Z" });
    const now = "2026-06-19T00:00:00.000Z";
    expect(isSearchBriefStale(brief, now, 7)).toBe(true);
  });

  it("自定义 staleDays=7，6 天前创建 → 不过期", () => {
    const brief = makeBrief({ createdAt: "2026-06-13T00:00:00.000Z" });
    const now = "2026-06-19T00:00:00.000Z";
    expect(isSearchBriefStale(brief, now, 7)).toBe(false);
  });
});

// ─── dedupeBriefSources ─────────────────────────────────────────────────────

describe("dedupeBriefSources", () => {
  it("无简报时返回空数组，duplicateCount=0", () => {
    const result = dedupeBriefSources([]);
    expect(result.briefs).toHaveLength(0);
    expect(result.duplicateCount).toBe(0);
  });

  it("无重复来源时原样返回，duplicateCount=0", () => {
    const brief1 = makeBrief({
      id: "brief-1",
      sources: [
        makeSource({ id: "src-1", url: "https://example.com/a", title: "文章A" }),
      ],
    });
    const brief2 = makeBrief({
      id: "brief-2",
      sources: [
        makeSource({ id: "src-2", url: "https://example.com/b", title: "文章B" }),
      ],
    });
    const result = dedupeBriefSources([brief1, brief2]);
    expect(result.briefs[0].sources).toHaveLength(1);
    expect(result.briefs[1].sources).toHaveLength(1);
    expect(result.duplicateCount).toBe(0);
  });

  it("两简报含相同 url 的 source → 第二个的该来源被剔除，duplicateCount=1", () => {
    const sharedUrl = "https://example.com/shared";
    const brief1 = makeBrief({
      id: "brief-1",
      sources: [
        makeSource({ id: "src-1", url: sharedUrl, title: "共享文章" }),
        makeSource({ id: "src-2", url: "https://example.com/unique1", title: "独有文章1" }),
      ],
    });
    const brief2 = makeBrief({
      id: "brief-2",
      sources: [
        makeSource({ id: "src-3", url: sharedUrl, title: "共享文章" }), // 同 url，应被剔除
        makeSource({ id: "src-4", url: "https://example.com/unique2", title: "独有文章2" }),
      ],
    });
    const result = dedupeBriefSources([brief1, brief2]);
    expect(result.briefs[0].sources).toHaveLength(2); // 第一个简报保留完整
    expect(result.briefs[1].sources).toHaveLength(1); // 第二个简报只剩独有那个
    expect(result.briefs[1].sources[0].url).toBe("https://example.com/unique2");
    expect(result.duplicateCount).toBe(1);
  });

  it("按 title 去重（无 url 或 url 为空时）", () => {
    const brief1 = makeBrief({
      id: "brief-1",
      sources: [
        makeSource({ id: "src-1", url: "", title: "重复标题" }),
      ],
    });
    const brief2 = makeBrief({
      id: "brief-2",
      sources: [
        makeSource({ id: "src-2", url: "", title: "重复标题" }), // 同 title，应被剔除
      ],
    });
    const result = dedupeBriefSources([brief1, brief2]);
    expect(result.briefs[1].sources).toHaveLength(0);
    expect(result.duplicateCount).toBe(1);
  });

  it("多个简报，多重重复时 duplicateCount 累加正确", () => {
    const src = (id: string, url: string) =>
      makeSource({ id, url, title: `title-${id}` });
    const brief1 = makeBrief({
      id: "b1",
      sources: [src("s1", "https://a.com"), src("s2", "https://b.com")],
    });
    const brief2 = makeBrief({
      id: "b2",
      sources: [src("s3", "https://a.com"), src("s4", "https://c.com")],
    });
    const brief3 = makeBrief({
      id: "b3",
      sources: [src("s5", "https://b.com"), src("s6", "https://d.com")],
    });
    const result = dedupeBriefSources([brief1, brief2, brief3]);
    expect(result.duplicateCount).toBe(2);
    expect(result.briefs[0].sources).toHaveLength(2);
    expect(result.briefs[1].sources).toHaveLength(1); // a.com 被剔除
    expect(result.briefs[2].sources).toHaveLength(1); // b.com 被剔除
  });

  it("不修改原始 brief 对象（immutable）", () => {
    const sharedUrl = "https://example.com/shared";
    const brief1 = makeBrief({
      id: "b1",
      sources: [makeSource({ id: "s1", url: sharedUrl })],
    });
    const brief2 = makeBrief({
      id: "b2",
      sources: [makeSource({ id: "s2", url: sharedUrl })],
    });
    const original1Sources = [...brief1.sources];
    const original2Sources = [...brief2.sources];

    dedupeBriefSources([brief1, brief2]);

    expect(brief1.sources).toHaveLength(original1Sources.length);
    expect(brief2.sources).toHaveLength(original2Sources.length);
  });
});

// ─── planResearchAgendaRun ──────────────────────────────────────────────────

describe("planResearchAgendaRun", () => {
  it("有主题的 state → agendaItems 非空", () => {
    const state = initialProductState;
    const now = "2026-06-19T12:00:00.000Z";
    const result = planResearchAgendaRun(state, now);
    expect(result.agendaItems.length).toBeGreaterThan(0);
  });

  it("无过期 tracked 简报 → staleTrackedBriefIds 不含新鲜的 tracked 简报", () => {
    const state = initialProductState;
    const now = "2026-06-19T12:00:00.000Z";
    const result = planResearchAgendaRun(state, now);
    // 验证没有被误判为过期的 tracked 简报
    const freshTrackedBriefs = state.searchBriefs.filter(
      (b) => b.tracked && !isSearchBriefStale(b, now)
    );
    freshTrackedBriefs.forEach((b) => {
      expect(result.staleTrackedBriefIds).not.toContain(b.id);
    });
  });

  it("有过期 tracked 简报 → staleTrackedBriefIds 含该过期简报 id", () => {
    const staleBrief = makeBrief({
      id: "stale-tracked-1",
      topic: "过期追踪主题",
      tracked: true,
      createdAt: "2026-05-01T00:00:00.000Z", // 49 天前
    });
    const stateWithStaleBrief: ProductState = {
      ...initialProductState,
      searchBriefs: [staleBrief, ...initialProductState.searchBriefs],
    };
    const now = "2026-06-19T12:00:00.000Z";
    const result = planResearchAgendaRun(stateWithStaleBrief, now);
    expect(result.staleTrackedBriefIds).toContain("stale-tracked-1");
  });

  it("非 tracked 的过期简报不应出现在 staleTrackedBriefIds", () => {
    const oldBrief = makeBrief({
      id: "old-untracked",
      tracked: false,
      createdAt: "2025-01-01T00:00:00.000Z",
    });
    const stateWithOldBrief: ProductState = {
      ...initialProductState,
      searchBriefs: [oldBrief, ...initialProductState.searchBriefs],
    };
    const now = "2026-06-19T12:00:00.000Z";
    const result = planResearchAgendaRun(stateWithOldBrief, now);
    expect(result.staleTrackedBriefIds).not.toContain("old-untracked");
  });

  it("是纯函数 — 多次调用同 state 返回相同结果", () => {
    const state = initialProductState;
    const now = "2026-06-19T12:00:00.000Z";
    const r1 = planResearchAgendaRun(state, now);
    const r2 = planResearchAgendaRun(state, now);
    expect(r1.agendaItems.map((i) => i.id)).toEqual(r2.agendaItems.map((i) => i.id));
    expect(r1.staleTrackedBriefIds).toEqual(r2.staleTrackedBriefIds);
  });
});
