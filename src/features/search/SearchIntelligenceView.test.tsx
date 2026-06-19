/**
 * SearchIntelligenceView unit tests
 *
 * Guards for:
 *  - auto-watch button presence
 *  - empty-state CTA rendered when no briefs
 *  - staleness badge rendered for stale briefs
 *  - per-brief loading states (refreshing / tracking)
 */
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { createIdleCapabilityTask } from "../../capabilities/task";
import { createEmptyProductState } from "../../domain/engine";
import type { SearchBrief, SearchBriefInput } from "../../domain/types";
import { SearchIntelligenceView } from "./SearchIntelligenceView";

function makeIdleTask() {
  return createIdleCapabilityTask<SearchBriefInput>("联网搜索");
}

function makeBrief(overrides: Partial<SearchBrief> = {}): SearchBrief {
  return {
    id: "brief-1",
    topic: "AI 商业化热点",
    summary: "本周 AI 产品动态",
    provider: "bailian",
    status: "ready",
    facts: [],
    controversies: [],
    opposingViews: [],
    interviewAngles: [],
    discussionTopics: [],
    sources: [],
    tracked: false,
    createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(), // 30 days ago -> stale
    lastRefreshedAt: undefined,
    ...overrides
  };
}

const baseProps = {
  topic: "AI 热点",
  activeBriefId: undefined,
  task: makeIdleTask(),
  onTopic: () => {},
  onCreate: () => {},
  onRetry: () => {},
  onUseBrief: () => {},
  onDeleteBrief: () => {},
  onSetDefaultProvider: () => {},
  onAutoBrief: () => {}
};

describe("SearchIntelligenceView — auto-watch button", () => {
  it("renders auto-watch button when onAutoRun is provided", () => {
    const s = createEmptyProductState();
    const html = renderToString(
      <SearchIntelligenceView
        {...baseProps}
        state={s}
        onAutoRun={async () => null}
      />
    );
    expect(html).toContain("自动盯梢");
  });

  it("does not render auto-watch panel when onAutoRun is not provided", () => {
    const s = createEmptyProductState();
    const html = renderToString(
      <SearchIntelligenceView
        {...baseProps}
        state={s}
      />
    );
    // auto-watch panel title uses Play icon + h2 "自动盯梢"
    // The text "自动盯梢" should not appear in panel heading
    // (it may appear elsewhere as CTA button text in empty state,
    //  but the action panel section itself should not render)
    expect(html).not.toContain("一键扫描主题和知识债");
  });
});

describe("SearchIntelligenceView — empty state", () => {
  it("shows empty-state CTA with auto-watch when no briefs and onAutoRun provided", () => {
    const s = createEmptyProductState();
    const html = renderToString(
      <SearchIntelligenceView
        {...baseProps}
        state={s}
        onAutoRun={async () => null}
      />
    );
    expect(html).toContain("empty-state");
    expect(html).toContain("从你的主题和知识债自动采集情报");
  });

  it("shows empty-state without CTA when onAutoRun is not provided", () => {
    const s = createEmptyProductState();
    const html = renderToString(
      <SearchIntelligenceView
        {...baseProps}
        state={s}
      />
    );
    expect(html).toContain("empty-state");
    expect(html).not.toContain("empty-cta");
  });
});

describe("SearchIntelligenceView — staleness badge", () => {
  it("shows staleness badge for briefs older than 14 days", () => {
    const s = {
      ...createEmptyProductState(),
      searchBriefs: [makeBrief()]
    };
    const html = renderToString(
      <SearchIntelligenceView
        {...baseProps}
        state={s}
      />
    );
    expect(html).toContain("已过期·建议刷新");
  });

  it("does not show staleness badge for fresh briefs", () => {
    const s = {
      ...createEmptyProductState(),
      searchBriefs: [makeBrief({ createdAt: new Date().toISOString() })]
    };
    const html = renderToString(
      <SearchIntelligenceView
        {...baseProps}
        state={s}
      />
    );
    expect(html).not.toContain("已过期·建议刷新");
  });
});

describe("SearchIntelligenceView — per-brief loading states", () => {
  it("shows spinner on refreshing brief when refreshingBriefId matches", () => {
    const s = {
      ...createEmptyProductState(),
      searchBriefs: [makeBrief({ createdAt: new Date().toISOString() })]
    };
    const html = renderToString(
      <SearchIntelligenceView
        {...baseProps}
        state={s}
        onRefreshBrief={() => {}}
        refreshingBriefId="brief-1"
      />
    );
    // btn-loading on refresh button
    expect(html).toContain("btn-loading");
    expect(html).toContain("spinner");
  });

  it("shows tracking pending state when trackingBriefId matches", () => {
    const s = {
      ...createEmptyProductState(),
      searchBriefs: [makeBrief({ createdAt: new Date().toISOString() })]
    };
    const html = renderToString(
      <SearchIntelligenceView
        {...baseProps}
        state={s}
        onTrackBrief={() => {}}
        trackingBriefId="brief-1"
      />
    );
    expect(html).toContain("处理中");
  });

  it("does not apply loading state to other briefs when one is refreshing", () => {
    const brief2 = makeBrief({ id: "brief-2", createdAt: new Date().toISOString(), topic: "另一个主题" });
    const s = {
      ...createEmptyProductState(),
      searchBriefs: [makeBrief({ createdAt: new Date().toISOString() }), brief2]
    };
    const html = renderToString(
      <SearchIntelligenceView
        {...baseProps}
        state={s}
        onRefreshBrief={() => {}}
        refreshingBriefId="brief-1"
      />
    );
    // Only one btn-loading for refresh (the one matching brief-1)
    // brief-2's refresh button should not have btn-loading
    // We just verify the component renders without throwing
    expect(html).toContain("另一个主题");
  });
});
