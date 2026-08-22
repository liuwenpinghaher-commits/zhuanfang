import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInitialProductState } from "../../domain/engine";
import type { PodcastEpisode } from "../../domain/types";
import { PodcastStudioView } from "./PodcastStudioView";

describe("PodcastStudioView", () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
    }
    root = undefined;
    container?.remove();
    container = undefined;
  });

  it("renders playable audio controls for real podcast audio URLs", () => {
    const state = createInitialProductState();
    const episode = createEpisode("https://cdn.example.com/podcast.mp3", {
      audioRenderStatus: "rendered",
      scriptReviewStatus: "用户确认"
    });

    renderView({
      ...state,
      podcastEpisodes: [episode]
    });

    const audio = container?.querySelector("audio");
    expect(audio).toBeTruthy();
    expect(audio?.controls).toBe(true);
    expect(audio?.querySelector("source")?.getAttribute("src")).toBe("https://cdn.example.com/podcast.mp3");
    expect(container?.textContent).toContain("可播放音频");
  });

  it("keeps local placeholder audio visibly non-playable", () => {
    const state = createInitialProductState();
    const episode = createEpisode("local-audio://podcast-test.mp3");

    renderView({
      ...state,
      podcastEpisodes: [episode]
    });

    expect(container?.querySelector("audio")).toBeNull();
    expect(container?.textContent).toContain("本地占位");
  });

  it("treats same-origin podcast audio routes as playable", () => {
    const state = createInitialProductState();
    const episode = createEpisode("/api/podcast/episodes/podcast-test/audio?t=1", {
      audioRenderStatus: "rendered",
      scriptReviewStatus: "用户确认"
    });

    renderView({
      ...state,
      podcastEpisodes: [episode]
    });

    const audio = container?.querySelector("audio");
    expect(audio).toBeTruthy();
    expect(audio?.querySelector("source")?.getAttribute("src")).toBe(
      "/api/podcast/episodes/podcast-test/audio?t=1"
    );
    expect(audio?.querySelector("source")?.getAttribute("type")).toBe("audio/wav");
  });

  it("does not show a player for pending episodes with leftover https URLs", () => {
    const state = createInitialProductState();
    const episode = createEpisode("https://cdn.example.com/stale.mp3", {
      audioRenderStatus: "pending",
      scriptReviewStatus: "用户确认"
    });

    renderView({
      ...state,
      podcastEpisodes: [episode]
    });

    expect(container?.querySelector("audio")).toBeNull();
    expect(container?.textContent).not.toContain("可播放音频");
  });

  it("shows confirm actions for pending scripts and synthesize after confirm", () => {
    const state = createInitialProductState();
    const pending = createEpisode("local-audio://pending.mp3", {
      audioRenderStatus: "pending",
      scriptReviewStatus: "待确认"
    });

    renderView(
      {
        ...state,
        podcastEpisodes: [pending]
      },
      { editingScript: pending.script, activeEpisodeId: pending.id }
    );

    expect(container?.textContent).toContain("确认这篇稿");
    expect(container?.textContent).toContain("确认并合成");
    expect(container?.textContent).not.toContain("合成语音");
    expect(container?.textContent).toContain("去确认");
  });

  it("shows host and guest voice selects for host-guest format", () => {
    const state = createInitialProductState();
    renderView(state, { format: "host-guest", guestVoice: "longanqian" });
    expect(container?.querySelector("#podcast-host-voice")).toBeTruthy();
    expect(container?.querySelector("#podcast-guest-voice")).toBeTruthy();
    expect(container?.textContent).toContain("主持人声音");
    expect(container?.textContent).toContain("来宾声音");
    expect(container?.querySelector("#podcast-voice")).toBeNull();
  });

  it("keeps stored guest voice in the library pill and episode draft selects", () => {
    const state = createInitialProductState();
    const episode = createEpisode("local-audio://pending.mp3", {
      format: "host-guest",
      voice: "longanlingxin",
      guestVoice: "longanqian",
      audioRenderStatus: "pending",
      scriptReviewStatus: "用户确认"
    });
    renderView(
      { ...state, podcastEpisodes: [episode] },
      {
        format: "host-guest",
        editingScript: episode.script,
        activeEpisodeId: episode.id,
        episodeVoice: episode.voice,
        episodeGuestVoice: episode.guestVoice
      }
    );
    expect(container?.textContent).toContain("主持对谈 · longanlingxin / longanqian");
    expect(container?.querySelector<HTMLSelectElement>("#episode-host-voice")?.value).toBe("longanlingxin");
    expect(container?.querySelector<HTMLSelectElement>("#episode-guest-voice")?.value).toBe("longanqian");
  });

  function renderView(
    state: ReturnType<typeof createInitialProductState>,
    extras?: {
      editingScript?: string;
      activeEpisodeId?: string | null;
      format?: PodcastEpisode["format"];
      guestVoice?: string;
      episodeVoice?: string;
      episodeGuestVoice?: string;
    }
  ) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(
        <PodcastStudioView
          state={state}
          noteId={state.notes[0]?.id ?? ""}
          voice="longanlingxin"
          guestVoice="longanqian"
          sourceType="note"
          sourceId=""
          format={extras?.format ?? "solo"}
          editingScript={extras?.editingScript ?? ""}
          episodeVoice={extras?.episodeVoice ?? (extras?.activeEpisodeId ? "longanlingxin" : "")}
          episodeGuestVoice={extras?.episodeGuestVoice ?? ""}
          activeEpisodeId={extras?.activeEpisodeId ?? null}
          onNoteId={vi.fn()}
          onVoice={vi.fn()}
          onGuestVoice={vi.fn()}
          onSourceType={vi.fn()}
          onSourceId={vi.fn()}
          onFormat={vi.fn()}
          onEditingScript={vi.fn()}
          onEpisodeVoice={vi.fn()}
          onEpisodeGuestVoice={vi.fn()}
          onBeginEditEpisode={vi.fn()}
          onActiveEpisodeId={vi.fn()}
          onGenerateScript={vi.fn()}
          onConfirmScript={vi.fn()}
          onConfirmAndSynthesize={vi.fn()}
          onSynthesizeSpeech={vi.fn()}
          onDeleteEpisode={vi.fn()}
          onSaveDefaultVoice={vi.fn()} />
      );
    });
  }
});

function createEpisode(audioUrl: string, extra?: Partial<PodcastEpisode>): PodcastEpisode {
  return {
    id: "podcast-test",
    noteId: "note-1",
    title: "播客：测试",
    format: "solo",
    voice: "longyuan_v3",
    status: "ready",
    scriptReviewStatus: "待确认",
    durationSec: 180,
    script: "完整脚本",
    chapters: [{ title: "开场", startsAtSec: 0, summary: "开场摘要" }],
    audioUrl,
    shownotes: ["shownote"],
    createdAt: "2026-06-10T00:00:00.000Z",
    ...extra
  };
}
