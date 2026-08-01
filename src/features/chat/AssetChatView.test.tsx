import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInitialProductState } from "../../domain/engine";
import { ApiError } from "../../api/productApi";
import { AssetChatView, ASSET_CHAT_DRAFT_ID, formatChatSendError } from "./AssetChatView";

describe("AssetChatView", () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  HTMLElement.prototype.scrollIntoView = vi.fn();
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(() => {
    if (root) act(() => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
  });

  function mount(ui: React.ReactNode) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(ui);
    });
  }

  it("按服务端 citation number 和 sourceLabel 渲染，不按数组位置重编号", () => {
    const state = createInitialProductState();
    state.chatSessions = [
      {
        id: "chat-1",
        title: "组织提效",
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-01T00:00:00.000Z",
        messages: [
          {
            id: "message-1",
            role: "assistant",
            content: "见来源[2]。",
            createdAt: "2026-07-01T00:00:00.000Z",
            groundingMode: "grounded",
            citations: [
              {
                number: 2,
                sourceType: "memory",
                sourceId: "memory-2",
                sourceLabel: "已确认长期记忆",
                title: "组织效率判断",
                snippet: "个人工具普及率不是组织提效的充分条件。"
              }
            ]
          }
        ]
      }
    ];
    mount(
      <AssetChatView
        state={state}
        onSend={vi.fn()}
        onNewChat={vi.fn()}
        onDeleteChat={vi.fn()}
        onSelectChat={vi.fn()}
        selectedSessionId="chat-1"
        onCitationClick={vi.fn()}
      />
    );

    const text = container!.textContent ?? "";
    expect(text).toContain("[2] (已确认长期记忆) 组织效率判断");
    expect(text).toContain("已依据资料");
    expect(text).not.toContain("[1] (记忆)");
  });

  it("草稿线程 ASSET_CHAT_DRAFT_ID 不回落最近历史会话", () => {
    const state = createInitialProductState();
    state.chatSessions = [
      {
        id: "chat-old",
        title: "旧会话标题不应出现在线程",
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-02T00:00:00.000Z",
        messages: [
          {
            id: "m1",
            role: "user",
            content: "历史用户消息XYZ",
            createdAt: "2026-07-02T00:00:00.000Z"
          },
          {
            id: "m2",
            role: "assistant",
            content: "历史助手回复ABC",
            createdAt: "2026-07-02T00:00:01.000Z"
          }
        ]
      }
    ];
    mount(
      <AssetChatView
        state={state}
        onSend={vi.fn()}
        onNewChat={vi.fn()}
        onDeleteChat={vi.fn()}
        onSelectChat={vi.fn()}
        selectedSessionId={ASSET_CHAT_DRAFT_ID}
        onCitationClick={vi.fn()}
      />
    );
    const text = container!.textContent ?? "";
    expect(text).toContain("草稿线程");
    expect(text).toContain("新对话已就绪");
    // 侧栏可显示历史标题/摘要；右侧线程不得渲染历史气泡（空态文案即可证明未选中旧会话）
    expect(text).toContain("旧会话标题不应出现在线程");
    expect(container!.querySelector(".chat-empty-thread")).toBeTruthy();
    expect(container!.querySelectorAll(".chat-msg").length).toBe(0);
  });

  it("formatChatSendError 透传 ApiError body.error", () => {
    const err = new ApiError(429, "/api/chat", { error: "本时段 LLM 预算已用尽，对话暂不可用，请稍后重试。" });
    expect(formatChatSendError(err)).toContain("预算已用尽");
  });
});
