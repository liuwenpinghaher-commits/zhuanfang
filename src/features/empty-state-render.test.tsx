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

describe("empty-state render guards", () => {
  it("HomeView renders on empty state without throwing", () => {
    const s = createEmptyProductState();
    expect(() =>
      renderToString(
        <HomeView
          state={s}
          card={buildInterviewCard(s)}
          monthlyReview={buildMonthlyReview(s)}
          onStart={() => {}}
        />
      )
    ).not.toThrow();
  });

  it("HomeView empty state shows placeholder copy instead of crashing", () => {
    const s = createEmptyProductState();
    const html = renderToString(
      <HomeView
        state={s}
        card={buildInterviewCard(s)}
        monthlyReview={buildMonthlyReview(s)}
        onStart={() => {}}
      />
    );
    expect(html).toContain("还没有长期主题");
    expect(html).toContain("还没有知识债");
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
          onAutoBrief={() => {}}
        />
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
          editingScript=""
          onNoteId={() => {}}
          onVoice={() => {}}
          onSourceType={() => {}}
          onSourceId={() => {}}
          onEditingScript={() => {}}
          onGenerateScript={() => {}}
          onSynthesizeSpeech={() => {}}
          onDeleteEpisode={() => {}}
          onSaveDefaultVoice={() => {}}
        />
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
      />
    );
    expect(html).toContain("还没有专访笔记");
  });

  it("ThemesView renders empty state copy when themes array is empty (P1-6)", () => {
    const s = createEmptyProductState();
    const html = renderToString(
      <ThemesView
        state={s}
        review={buildMonthlyReview(s)}
        yearlyReview={buildYearlyReview(s)}
        radar={buildCognitiveRadar(s)}
        onStart={() => {}}
      />
    );
    expect(html).toContain("还没有主题线");
  });
});
