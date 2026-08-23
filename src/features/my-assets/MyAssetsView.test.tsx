/**
 * MyAssetsView component tests.
 * Uses renderToString (no DOM) matching the project pattern in empty-state-render.test.tsx.
 */
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  createEmptyProductState,
  searchProductAssets
} from "../../domain/engine";
import type { ProductState } from "../../domain/types";
import { AssetsView } from "../assets/AssetsView";
import { MyAssetsView } from "./MyAssetsView";

function makeAssetsProps(state: ProductState) {
  const results = searchProductAssets(state, "");
  return {
    state,
    query: "",
    results,
    filter: "all" as const,
    selectedAssetKey: undefined,
    onQuery: vi.fn(),
    onFilter: vi.fn(),
    onSelectAsset: vi.fn(),
    onToggleImportant: vi.fn(),
    onPointStatus: vi.fn(),
    onQuestionStatus: vi.fn(),
    onDebtStatus: vi.fn(),
    onDecisionStatus: vi.fn(),
    onDecisionConfirm: vi.fn(),
    onGeneratePodcast: vi.fn()
  };
}

describe("MyAssetsView", () => {
  it("renders archive tab empty state when notes array is empty", () => {
    const s = createEmptyProductState();
    const html = renderToString(
      <MyAssetsView {...makeAssetsProps(s)} initialTab="archive" />
    );
    expect(html).toContain("还没有专访档案");
  });

  it("renders archive card with title and output badges when note exists", () => {
    const s = createEmptyProductState();
    const noteId = "note-test-001";
    const note = {
      id: noteId,
      sessionId: "sess-001",
      title: "测试专访标题",
      summary: "这是摘要内容",
      keyQuote: "核心金句在此",
      saidTrack: ["说了内容A", "说了内容B"],
      learnedTrack: ["学到X", "学到Y"],
      nextQuestions: [],
      createdAt: "2024-01-15T10:00:00Z"
    };
    const stateWithNote: ProductState = {
      ...s,
      notes: [note],
      points: [
        {
          id: "p1",
          sourceSessionId: "sess-001",
          title: "观点一",
          content: "内容",
          confidence: "AI 推断",
          status: "临时想法",
          important: false,
          evidence: [],
          relatedThemeIds: [],
          updatedAt: "2024-01-15T10:00:00Z"
        }
      ]
    };
    const html = renderToString(
      <MyAssetsView {...makeAssetsProps(stateWithNote)} initialTab="archive" />
    );
    expect(html).toContain("测试专访标题");
    // React renderToString splits adjacent text nodes with <!-- --> comments,
    // so "1 观点" becomes "1<!-- --> <!-- -->观点" in the output. Match each part.
    expect(html).toContain(">1<");
    expect(html).toContain("观点");
    expect(html).toContain("问题");
    expect(html).toContain("决策");
    expect(html).toContain("债");
    expect(html).toContain("output-badge--active");
    expect(html).toContain("生成播客");
  });

  it("archive card shows dual-track when saidTrack and learnedTrack have items", () => {
    const s = createEmptyProductState();
    const note = {
      id: "note-002",
      sessionId: "sess-002",
      title: "双轨档案",
      summary: "",
      keyQuote: "",
      saidTrack: ["我说了A", "我说了B"],
      learnedTrack: ["学到了P"],
      nextQuestions: [],
      createdAt: "2024-02-01T08:00:00Z"
    };
    const stateWithNote: ProductState = { ...s, notes: [note] };
    const html = renderToString(
      <MyAssetsView {...makeAssetsProps(stateWithNote)} initialTab="archive" />
    );
    expect(html).toContain("我说了什么");
    expect(html).toContain("我说了A");
    expect(html).toContain("我学到了什么");
    expect(html).toContain("学到了P");
  });

it("assets tab renders AssetsView content (search panel) without nested page title", () => {
    const s = createEmptyProductState();
    const html = renderToString(
      <MyAssetsView {...makeAssetsProps(s)} initialTab="assets" />
    );
    // Embedded AssetsView keeps search, hides duplicate HeaderBlock title.
    expect(html).toContain("asset-search");
    expect(html).toContain("搜索原话、观点、问题、决策或知识债");
    expect(html).not.toContain("用筛选、列表和详情面板管理认知资产");
  });

  it("archive badges are buttons and card is not keyboard-bound to podcast", () => {
    const s = createEmptyProductState();
    const note = {
      id: "note-test-001",
      sessionId: "sess-001",
      title: "测试专访标题",
      summary: "这是摘要内容",
      keyQuote: "核心金句在此",
      saidTrack: ["说了内容A"],
      learnedTrack: ["学到X"],
      nextQuestions: [],
      createdAt: "2024-01-15T10:00:00Z"
    };
    const stateWithNote: ProductState = {
      ...s,
      notes: [note],
      points: [
        {
          id: "p1",
          sourceSessionId: "sess-001",
          title: "观点一",
          content: "内容",
          confidence: "AI 推断",
          status: "临时想法",
          important: false,
          evidence: [],
          relatedThemeIds: [],
          updatedAt: "2024-01-15T10:00:00Z"
        }
      ]
    };
    const html = renderToString(
      <MyAssetsView {...makeAssetsProps(stateWithNote)} initialTab="archive" onOpenNote={vi.fn()} />
    );
    expect(html).toContain("output-badge--button");
    expect(html).toContain('data-archive-session="sess-001"');
    expect(html).not.toContain("row-clickable");
    expect(html).toContain("打开笔记");
  });

  it("renders both tabs in navigation", () => {
    const s = createEmptyProductState();
    const html = renderToString(
      <MyAssetsView {...makeAssetsProps(s)} />
    );
    expect(html).toContain("专访档案");
    expect(html).toContain("资产库");
  });

  it("renders without throwing on fully empty state", () => {
    const s = createEmptyProductState();
    expect(() =>
      renderToString(<MyAssetsView {...makeAssetsProps(s)} />)
    ).not.toThrow();
  });
});

describe("AssetsView session scope matches archive badges", () => {
  it("keeps a later appearance even when sourceSessionId is another session", () => {
    const s = createEmptyProductState();
    const state: ProductState = {
      ...s,
      points: [
        {
          id: "p-later",
          sourceSessionId: "sess-1",
          appearedInSessionIds: ["sess-1", "sess-2"],
          title: "后来又出现的观点",
          content: "第二场又碰到了",
          confidence: "用户确认",
          status: "稳定观点",
          important: false,
          evidence: [],
          relatedThemeIds: [],
          updatedAt: "2024-02-01T00:00:00Z"
        },
        {
          id: "p-other",
          sourceSessionId: "sess-1",
          title: "只属于第一场",
          content: "没再出现",
          confidence: "AI 推断",
          status: "临时想法",
          important: false,
          evidence: [],
          relatedThemeIds: [],
          updatedAt: "2024-01-01T00:00:00Z"
        }
      ]
    };
    const html = renderToString(
      <AssetsView
        {...makeAssetsProps(state)}
        embedded
        sessionScopeId="sess-2"
      />
    );
    expect(html).toContain("后来又出现的观点");
    expect(html).not.toContain("只属于第一场");
  });
});

