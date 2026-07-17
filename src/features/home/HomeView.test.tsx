import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildInterviewCard, createInitialProductState } from "../../domain/engine";
import type { InterviewMode } from "../../domain/types";
import { HomeView } from "./HomeView";

describe("HomeView 专访启动真值", () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(() => {
    if (root) act(() => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
  });

  it("一键开始展示并提交可见的推荐模式与主题", () => {
    const state = createInitialProductState();
    const onStart = vi.fn<(mode?: InterviewMode, topicHint?: string) => void>();
    renderHome(state, onStart);

    const button = Array.from(container?.querySelectorAll("button") ?? []).find((item) => item.textContent?.includes("一键开始"));
    act(() => button?.click());

    expect(container?.textContent).toContain("长期主题");
    expect(container?.textContent).toContain("适合回访反复出现的问题");
    expect(onStart).toHaveBeenCalledWith("long-term", "控制感");
  });

  it("允许用户输入具体主题并按组织模式原样启动", () => {
    const state = createInitialProductState();
    const onStart = vi.fn<(mode?: InterviewMode, topicHint?: string) => void>();
    renderHome(state, onStart);
    const input = container?.querySelector("input[placeholder*='专访主题']") as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    act(() => {
      setter?.call(input, "企业如何进行 AI Native 转型");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const organization = Array.from(container?.querySelectorAll("button") ?? []).find((item) => item.textContent?.includes("组织/关系"));
    act(() => organization?.click());

    expect(onStart).toHaveBeenCalledWith("organization", "企业如何进行 AI Native 转型");
  });

  function renderHome(
    state: ReturnType<typeof createInitialProductState>,
    onStart: (mode?: InterviewMode, topicHint?: string) => void
  ) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(
        <HomeView
          state={state}
          card={buildInterviewCard(state)}
          suggestedTopicHint="控制感"
          recommendedMode="long-term"
          recommendationReason="适合回访反复出现的问题"
          onStart={onStart}
        />
      );
    });
  }
});
