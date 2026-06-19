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

  it("assets tab renders AssetsView content (search panel)", () => {
    const s = createEmptyProductState();
    const html = renderToString(
      <MyAssetsView {...makeAssetsProps(s)} initialTab="assets" />
    );
    expect(html).toContain("观点、问题、决策和知识债");
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
