import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInitialProductState } from "../../domain/engine";
import { AssetChatView } from "./AssetChatView";

describe("AssetChatView citations", () => {
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

  it("按服务端 citation number 和 sourceLabel 渲染，不按数组位置重编号", () => {
    const state = createInitialProductState();
    state.chatSessions = [{
      id: "chat-1", title: "组织提效", createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z",
      messages: [{
        id: "message-1", role: "assistant", content: "见来源[2]。", createdAt: "2026-07-01T00:00:00.000Z",
        citations: [{
          number: 2,
          sourceType: "memory",
          sourceId: "memory-2",
          sourceLabel: "已确认长期记忆",
          title: "组织效率判断",
          snippet: "个人工具普及率不是组织提效的充分条件。"
        }]
      }]
    }];
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(<AssetChatView
        state={state} onSend={vi.fn()} onNewChat={vi.fn()} onDeleteChat={vi.fn()} onSelectChat={vi.fn()}
        selectedSessionId="chat-1" onCitationClick={vi.fn()}
      />);
    });

    const text = container.textContent ?? "";
    expect(text).toContain("[2] (已确认长期记忆) 组织效率判断");
    expect(text).not.toContain("[1] (记忆)");
  });
});
