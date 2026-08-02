import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInitialProductState, createSessionDraft } from "../../domain/engine";
import { formatInterviewHeaderTitle, InterviewView } from "./InterviewView";

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

  it("标题去掉重复的继续追问前缀", () => {
    const session = createSessionDraft(createInitialProductState(), "decision", "standard", {
      topicHint: "控制感"
    });
    // Simulate stacked title from product
    session.title = "决策专访：继续追问：控制感";
    session.mode = "decision";
    expect(formatInterviewHeaderTitle(session)).toBe("决策专访 · 控制感");
  });

  it("空场显示开场 hero 且控制默认折叠", () => {
    const session = createSessionDraft(createInitialProductState(), "organization");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(
        <InterviewView
          card={session.card}
          session={session}
          pendingMode="organization"
          input=""
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
        />
      );
    });
    expect(container.querySelector('[data-testid="opening-hero"]')?.textContent).toContain(
      session.card.suggestedOpening
    );
    expect(container.querySelector(".control-groups")).toBeNull();
    expect(container.textContent).toContain("访谈调节");
    expect(container.textContent).toContain("默认文本追问");
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
          retryAvailable />
      );
    });

    expect(container.querySelector("button[type='submit']")?.textContent).toContain("重试本轮");
  });

  it("只展示服务端本轮结构化引用，不回退到 referencedMemory 或卡片首项", () => {
    const session = createSessionDraft(createInitialProductState(), "organization");
    session.card.historyReferences = ["错误的卡片首项"];
    session.turns = [{
      id: "assistant-1",
      sessionId: session.id,
      role: "assistant",
      content: "这条判断在哪个节点可以验证？",
      intent: "追问",
      timestamp: new Date().toISOString(),
      referencedMemory: "错误的旧字符串引用",
      references: [{
        id: "memory:memory-1",
        type: "memory",
        text: "个人工具普及率不是组织提效的充分条件。",
        sourceEntityType: "memory_record",
        sourceEntityId: "memory-1",
        sourceLabel: "已确认长期记忆"
      }]
    } as (typeof session.turns)[number]];
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(<InterviewView
        card={session.card} session={session} pendingMode="organization" input="" recording={false}
        realtimeState={null} audioLevel={0} voiceStatus="idle" liveUserTranscript="" voiceTransport={null}
        onInput={vi.fn()} onStart={vi.fn()} onSubmit={vi.fn()} onFinish={vi.fn()} onControl={vi.fn()}
        onToggleRecording={vi.fn()} onInterrupt={vi.fn()} />);
    });

    const turnText = container.querySelector(".turn.assistant")?.textContent ?? "";
    expect(turnText).toContain("个人工具普及率不是组织提效的充分条件。");
    expect(turnText).toContain("已确认长期记忆");
    expect(turnText).not.toContain("错误的旧字符串引用");
  });

  it("旧回合只有 referencedMemory 时明确标注缺少结构化引用", () => {
    const session = createSessionDraft(createInitialProductState(), "organization");
    session.turns = [{
      id: "assistant-legacy", sessionId: session.id, role: "assistant", content: "旧问题", intent: "追问",
      timestamp: new Date().toISOString(), referencedMemory: "无法核验来源的旧引用"
    }];
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(<InterviewView
        card={session.card} session={session} pendingMode="organization" input="" recording={false}
        realtimeState={null} audioLevel={0} voiceStatus="idle" liveUserTranscript="" voiceTransport={null}
        onInput={vi.fn()} onStart={vi.fn()} onSubmit={vi.fn()} onFinish={vi.fn()} onControl={vi.fn()}
        onToggleRecording={vi.fn()} onInterrupt={vi.fn()} />);
    });

    const turnText = container.querySelector(".turn.assistant")?.textContent ?? "";
    expect(turnText).toContain("未提供结构化引用");
    expect(turnText).not.toContain("无法核验来源的旧引用");
  });

  it("可编辑、确认或丢弃被回声保护隔离的转写", () => {
    const session = createSessionDraft(createInitialProductState(), "organization");
    const onVoiceReviewText = vi.fn();
    const onConfirmVoiceReview = vi.fn();
    const onDiscardVoiceReview = vi.fn();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(<InterviewView
        card={session.card} session={session} pendingMode="organization" input="" recording
        realtimeState={null} audioLevel={0} voiceStatus="listening" liveUserTranscript="" voiceTransport="websocket"
        voiceReviewItem={{ text: "你能讲一个具体例子吗？", reason: "与刚才 AI 语音高度相似", source: "echo" }}
        onVoiceReviewText={onVoiceReviewText} onConfirmVoiceReview={onConfirmVoiceReview}
        onDiscardVoiceReview={onDiscardVoiceReview}
        onInput={vi.fn()} onStart={vi.fn()} onSubmit={vi.fn()} onFinish={vi.fn()} onControl={vi.fn()}
        onToggleRecording={vi.fn()} onInterrupt={vi.fn()} />);
    });

    const review = container.querySelector("[data-testid='voice-review']");
    expect(review?.textContent).toContain("等待确认的转写");
    expect((review?.querySelector("textarea") as HTMLTextAreaElement | null)?.value).toBe("你能讲一个具体例子吗？");

    act(() => {
      review?.querySelector<HTMLButtonElement>("button[data-action='confirm']")?.click();
      review?.querySelector<HTMLButtonElement>("button[data-action='discard']")?.click();
    });
    expect(onConfirmVoiceReview).toHaveBeenCalledOnce();
    expect(onDiscardVoiceReview).toHaveBeenCalledOnce();
  });

  for (const [status, copy] of [
    ["reconnecting", "语音连接恢复中，请稍候"],
    ["degraded", "语音兼容模式"],
    ["exhausted", "语音连接未恢复，已保留本场文字专访"],
  ] as const) {
    it(`显示 ${status}`, () => {
      const session = createSessionDraft(createInitialProductState(), "organization");
      container = document.createElement("div");
      document.body.appendChild(container);
      root = createRoot(container);

      act(() => {
        root?.render(<InterviewView
          card={session.card} session={session} pendingMode="organization" input=""
          recording={status !== "exhausted"} realtimeState={null} audioLevel={0}
          voiceStatus={status} liveUserTranscript="" voiceTransport="websocket"
          onInput={vi.fn()} onStart={vi.fn()} onSubmit={vi.fn()} onFinish={vi.fn()}
          onControl={vi.fn()} onToggleRecording={vi.fn()} onInterrupt={vi.fn()} />);
      });

      expect(container.textContent).toContain(copy);
    });
  }

  it("recovery review 不再声称一定混入 AI 语音", () => {
    const session = createSessionDraft(createInitialProductState(), "organization");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(<InterviewView
        card={session.card} session={session} pendingMode="organization" input="" recording
        realtimeState={null} audioLevel={0} voiceStatus="reconnecting" liveUserTranscript=""
        voiceTransport="websocket"
        voiceReviewItem={{ text: "未完成尾段", reason: "连接中断", source: "recovery" }}
        onInput={vi.fn()} onStart={vi.fn()} onSubmit={vi.fn()} onFinish={vi.fn()}
        onControl={vi.fn()} onToggleRecording={vi.fn()} onInterrupt={vi.fn()} />);
    });

    expect(container.textContent).toContain("连接中断前的尾段尚未确认");
    expect(container.textContent).toContain("尚未写入专访");
  });
});
