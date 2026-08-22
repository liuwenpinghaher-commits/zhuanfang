/**
 * Regression guard: every view that touches state arrays must render without
 * throwing when the state is fully empty (post "清空示例，开始我的真实记录" reset).
 *
 * Uses renderToString (no DOM / browser needed) so these run as plain vitest
 * unit tests.  A crash here = P4-T2 reset would blank-screen a real user.
 */
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createIdleCapabilityTask } from "../capabilities/task";
import {
  buildCognitiveRadar,
  buildInterviewCard,
  buildMonthlyReview,
  buildYearlyReview,
  createEmptyProductState
} from "../domain/engine";
import type { SearchBriefInput } from "../domain/types";
import { HomeView } from "./home/HomeView";
import { NotesView } from "./notes/NotesView";
import { PodcastStudioView } from "./podcast/PodcastStudioView";
import { SearchIntelligenceView } from "./search/SearchIntelligenceView";
import { ThemesView } from "./themes/ThemesView";
import { MaterialLibraryView } from "./material/MaterialLibraryView";

describe("empty-state render guards", () => {
  it("HomeView renders on empty state without throwing", () => {
    const s = createEmptyProductState();
    expect(() =>
      renderToString(
        <HomeView
          state={s}
          card={buildInterviewCard(s)}
          onStart={() => {}} />
      )
    ).not.toThrow();
  });

  it("HomeView empty state shows timeline empty copy", () => {
    const s = createEmptyProductState();
    const html = renderToString(
      <HomeView
        state={s}
        card={buildInterviewCard(s)}
        onStart={() => {}} />
    );
    expect(html).toContain("开始第一次专访");
    expect(html).toContain("你的记录会在这里形成时间轴");
  });

  it("HomeView empty state shows track chip row empty copy", () => {
    const s = createEmptyProductState();
    const html = renderToString(
      <HomeView
        state={s}
        card={buildInterviewCard(s)}
        onStart={() => {}} />
    );
    expect(html).toContain("还没有主题线");
    expect(html).toContain("完成专访后会自动浮现");
  });

  it("HomeView with onOpenTrack and onNavigate renders without throwing", () => {
    const s = createEmptyProductState();
    expect(() =>
      renderToString(
        <HomeView
          state={s}
          card={buildInterviewCard(s)}
          onStart={() => {}}
          onOpenTrack={() => {}}
          onNavigate={() => {}} />
      )
    ).not.toThrow();
  });

  it("SearchIntelligenceView renders on empty state without throwing", () => {
    const s = createEmptyProductState();
    const idleTask = createIdleCapabilityTask<SearchBriefInput>("联网搜索");
    expect(() =>
      renderToString(
        <SearchIntelligenceView
          state={s}
          topic=""
          activeBriefId={undefined}
          task={idleTask}
          onTopic={() => {}}
          onCreate={() => {}}
          onRetry={() => {}}
          onUseBrief={() => {}}
          onDeleteBrief={() => {}}
          onSetDefaultProvider={() => {}}
          onAutoBrief={() => {}} />
      )
    ).not.toThrow();
  });

  it("PodcastStudioView renders on empty state without throwing", () => {
    const s = createEmptyProductState();
    expect(() =>
      renderToString(
<PodcastStudioView
          state={s}
          noteId=""
          voice=""
          sourceType="note"
          sourceId=""
          format="solo"
          editingScript=""
          activeEpisodeId={null}
          onNoteId={() => {}}
          onVoice={() => {}}
          onSourceType={() => {}}
          onSourceId={() => {}}
          onFormat={() => {}}
          onActiveEpisodeId={() => {}}
          onEditingScript={() => {}}
          onGenerateScript={() => {}}
          onConfirmScript={() => {}}
          onConfirmAndSynthesize={() => {}}
          onSynthesizeSpeech={() => {}}
          onDeleteEpisode={() => {}}
          onSaveDefaultVoice={() => {}} />
      )
    ).not.toThrow();
  });

  it("NotesView renders empty state copy when notes array is empty (P1-5)", () => {
    const s = createEmptyProductState();
    const html = renderToString(
      <NotesView
        state={s}
        onStart={() => {}}
        onSaveQuestion={() => {}}
        onAddAnnotation={() => {}}
        onRemoveAnnotation={() => {}}
        getRawMaterial={async () => null} />
    );
    expect(html).toContain("还没有专访笔记");
    expect(html).toContain("开始一场专访");
    expect(html).toContain("阅读与回访");
  });

  it("NotesView surfaces revisit CTA and light pill for notes with questions", () => {
    const s = createEmptyProductState();
    s.notes = [
      {
        id: "note-1",
        sessionId: "sess-1",
        title: "关于控制感",
        summary: "完整摘要",
        keyQuote: "我有点矛盾",
        saidTrack: ["原话一", "原话二"],
        learnedTrack: ["学到一"],
        nextQuestions: ["矛盾具体卡在哪？"],
        createdAt: new Date().toISOString()
      },
      {
        id: "note-light",
        sessionId: "sess-2",
        title: "轻量场",
        summary: "【轻量记录·未生成资产】关键表达：试一下",
        keyQuote: "试一下",
        saidTrack: ["试一下"],
        learnedTrack: ["（本次为轻量记录：AI 综合暂不可用，仅保留你的原话，未做深度提炼或资产抽取。）"],
        nextQuestions: [],
        createdAt: new Date().toISOString()
      }
    ];
    const html = renderToString(
      <NotesView
        state={s}
        onStart={() => {}}
        onSaveQuestion={() => {}}
        onAddAnnotation={() => {}}
        onRemoveAnnotation={() => {}}
        getRawMaterial={async () => null} />
    );
    expect(html).toContain("用下个问题开场");
    expect(html).toContain("用此问题开场");
    expect(html).toContain("保存到资产库");
    expect(html).toContain("轻量记录");
    expect(html).toContain("矛盾具体卡在哪？");
  });

  it("MaterialLibraryView renders empty workshop copy", () => {
    const s = createEmptyProductState();
    const html = renderToString(
      <MaterialLibraryView
        state={s}
        onImport={async () => ({ sourceId: "x", candidateCount: 0 })}
        onRebuildIndex={async () => ({ chunkCount: 0 })}
        onDeleteSource={() => {}} />
    );
    expect(html).toContain("还没有导入任何素材");
    expect(html).toContain("原料车间");
    expect(html).toContain("重建知识索引");
    // 未接线 onAskMaterials 时不展示就资料提问面板
    expect(html).not.toContain("就资料提问");
  });

  it("MaterialLibraryView shows ask-materials panel when onAskMaterials is wired", () => {
    const s = createEmptyProductState();
    const html = renderToString(
      <MaterialLibraryView
        state={s}
        onImport={async () => ({ sourceId: "x", candidateCount: 0 })}
        onRebuildIndex={async () => ({ chunkCount: 0 })}
        onDeleteSource={() => {}}
        onAskMaterials={async () => ({ answer: "暂无", citations: [] })}
      />
    );
    expect(html).toContain("就资料提问");
    expect(html).toContain("仅检索已导入的参考文献块");
  });

  it("ThemesView renders empty state copy when themes array is empty (P1-6)", () => {
    const s = createEmptyProductState();
    const html = renderToString(
      <ThemesView
        state={s}
        review={buildMonthlyReview(s)}
        yearlyReview={buildYearlyReview(s)}
        radar={buildCognitiveRadar(s)}
        onStart={() => {}} />
    );
    expect(html).toContain("还没有主题线");
    expect(html).toContain("去完成一场专访");
  });

  it("ThemesView shows retry when reviews error and no review payload", () => {
    const s = createEmptyProductState();
    const html = renderToString(
      <ThemesView
        state={s}
        review={null}
        yearlyReview={null}
        radar={buildCognitiveRadar(s)}
        reviewsError="复盘 LLM 未配置"
        onRetryReviews={() => {}}
        onStart={() => {}} />
    );
    expect(html).toContain("复盘不可用");
    expect(html).toContain("复盘 LLM 未配置");
    expect(html).toContain("重试");
  });
});
