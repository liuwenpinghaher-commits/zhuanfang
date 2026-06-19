/**
 * SearchIntelligenceView unit tests
 *
 * Guards for:
 *  - auto-watch button presence + single Play icon (no literal triangle glyph)
 *  - consolidated provider control: one dropdown + one "设为默认" button
 *    (no legacy 3-button quick group, no 3 "设为默认：X" chips)
 *  - empty-state CTA rendered when no briefs
 *  - staleness badge rendered for stale briefs
 *  - per-brief loading states (refreshing / tracking)
 */
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createIdleCapabilityTask } from "../../capabilities/task";
import { createEmptyProductState } from "../../domain/engine";
import { searchProviderIds, searchProviderLabels } from "../../capabilities/contracts";
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
    sourceAngles: [],
    sources: [],
    sourceTrace: [],
    appliedToSessionIds: [],
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
    expect(html).not.toContain("一键扫描主题和知识债");
  });

  it("renders a single Play icon without a literal triangle glyph", () => {
    const s = createEmptyProductState();
    const html = renderToString(
      <SearchIntelligenceView
        {...baseProps}
        state={s}
        onAutoRun={async () => null}
      />
    );
    // The double-icon bug rendered a literal "▶" alongside the lucide <Play> svg.
    expect(html).not.toContain("▶");
    expect(html).not.toContain("▷");
    // lucide-react renders an inline <svg> for the Play icon.
    expect(html).toContain("<svg");
  });
});

describe("SearchIntelligenceView — consolidated provider control", () => {
  it("renders one search-provider dropdown listing every registered provider", () => {
    const s = createEmptyProductState();
    const html = renderToString(
      <SearchIntelligenceView
        {...baseProps}
        state={s}
      />
    );
    // exactly one <select id="search-provider">
    expect(html).toContain('id="search-provider"');
    const selectCount = html.split('<select').length - 1;
    expect(selectCount).toBe(1);
    // every provider label appears as an option
    for (const provider of searchProviderIds) {
      expect(html).toContain(searchProviderLabels[provider]);
    }
  });

  it("renders exactly one 设为默认 button (no per-provider default chips)", () => {
    const s = createEmptyProductState();
    const html = renderToString(
      <SearchIntelligenceView
        {...baseProps}
        state={s}
      />
    );
    const setDefaultCount = html.split("设为默认").length - 1;
    expect(setDefaultCount).toBe(1);
    // the legacy chips used "设为默认：<label>" — that pattern must be gone
    expect(html).not.toContain("设为默认：");
  });

  it("renders a 生成简报 action button", () => {
    const s = createEmptyProductState();
    const html = renderToString(
      <SearchIntelligenceView
        {...baseProps}
        state={s}
      />
    );
    expect(html).toContain("生成简报");
  });

  it("does not render the legacy 3-button provider quick group", () => {
    const s = createEmptyProductState();
    const html = renderToString(
      <SearchIntelligenceView
        {...baseProps}
        state={s}
      />
    );
    expect(html).not.toContain("provider-action-group");
    expect(html).not.toContain("provider-default-actions");
    // legacy quick-button labels (distinct from the dropdown option labels)
    expect(html).not.toContain("百炼联网");
    expect(html).not.toContain("本地演示");
  });

  it("shows current default provider as a read-only config hint", () => {
    const s = createEmptyProductState();
    const html = renderToString(
      <SearchIntelligenceView
        {...baseProps}
        state={s}
      />
    );
    expect(html).toContain("config-hint");
    expect(html).toContain("当前默认 provider");
    expect(html).toContain("会中引用");
    expect(html).toContain("最大来源");
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
    expect(html).toContain("另一个主题");
  });
});
