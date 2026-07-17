import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInitialProductState, createSessionDraft } from "../../domain/engine";
import { InterviewView } from "./InterviewView";

describe("InterviewView", () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(() => {
    if (root) act(() => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
  });

  it("失败轮恢复输入后显示明确的重试本轮操作", () => {
    const state = createInitialProductState();
    const session = createSessionDraft(state, "organization", "standard", {
      topicHint: "企业如何进行 AI Native 转型"
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <InterviewView
          card={session.card}
          session={session}
          pendingMode="organization"
          input="个人提效十倍，但组织效率没有明显变化。"
          recording={false}
          realtimeState={null}
          audioLevel={0}
          voiceStatus="idle"
          liveUserTranscript=""
          voiceTransport={null}
          onInput={vi.fn()}
          onStart={vi.fn()}
          onSubmit={vi.fn()}
          onFinish={vi.fn()}
          onControl={vi.fn()}
          onToggleRecording={vi.fn()}
          onInterrupt={vi.fn()}
          retryAvailable
        />
      );
    });

    expect(container.querySelector("button[type='submit']")?.textContent).toContain("重试本轮");
  });
});
