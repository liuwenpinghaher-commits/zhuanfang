import { describe, it, expect } from "vitest";
import { buildTimeline, buildTrackWorkspace } from "./timeline";
import { createInitialProductState } from "./engine";
import type { ProductState } from "./types";

describe("buildTimeline", () => {
  it("merges sessions/notes/themes into reverse-chronological events", () => {
    const s = createInitialProductState();
    const events = buildTimeline(s, 50);
    expect(events.length).toBeGreaterThan(0);
    for (let i = 1; i < events.length; i++) {
      expect(events[i - 1].at >= events[i].at).toBe(true);
    }
    expect(events.some((e) => e.kind === "session")).toBe(false); // seed has no sessions
  });

  it("respects limit and returns [] for empty state", () => {
    const empty = {
      ...createInitialProductState(),
      sessions: [],
      notes: [],
      themes: [],
      points: [],
      questions: [],
      decisions: [],
      debts: [],
    } as ProductState;
    expect(buildTimeline(empty, 10)).toEqual([]);
    const s = createInitialProductState();
    expect(buildTimeline(s, 1).length).toBeLessThanOrEqual(1);
  });

  it("includes note events and theme events from seed data", () => {
    const s = createInitialProductState();
    const events = buildTimeline(s, 50);
    expect(events.some((e) => e.kind === "note")).toBe(true);
    expect(events.some((e) => e.kind === "theme")).toBe(true);
  });
});

describe("buildTrackWorkspace", () => {
  it("aggregates sessions/outputs/sources for a theme by relatedThemeIds", () => {
    const s = createInitialProductState();
    const themeId = s.themes[0].id; // theme-control
    const ws = buildTrackWorkspace(s, themeId);
    expect(ws.theme?.id).toBe(themeId);
    // seed 中 source-control-note 挂到 theme-control，应出现在 sources
    expect(ws.sources.every((src) => (src.relatedThemeIds ?? []).includes(themeId))).toBe(true);
    ws.outputs.points.forEach((p) => expect(p.relatedThemeIds).toContain(themeId));
    ws.sessions.forEach((sess) => expect(sess.relatedThemeIds ?? []).toContain(themeId));
  });

  it("sources 包含 relatedThemeIds 含该 themeId 的 importSource；不含的不出现", () => {
    const base = createInitialProductState();
    const themeId = base.themes[0].id; // theme-control
    const matchingSource = {
      id: "src-match",
      title: "控制感相关资料",
      sourceType: "text" as const,
      content: "内容",
      status: "chunked" as const,
      sensitivity: "normal" as const,
      chunkIds: [],
      relatedThemeIds: [themeId],
      createdAt: "2026-06-06T00:00:00.000Z",
      updatedAt: "2026-06-06T00:00:00.000Z"
    };
    const unmatchedSource = {
      ...matchingSource,
      id: "src-no-match",
      title: "其他资料",
      relatedThemeIds: ["theme-other-xyz"]
    };
    const s: ProductState = { ...base, importSources: [matchingSource, unmatchedSource] };
    const ws = buildTrackWorkspace(s, themeId);
    expect(ws.sources.map((src) => src.id)).toContain("src-match");
    expect(ws.sources.map((src) => src.id)).not.toContain("src-no-match");
  });

  it("returns empty groups + undefined theme for unknown id", () => {
    const s = createInitialProductState();
    const ws = buildTrackWorkspace(s, "theme-does-not-exist");
    expect(ws.theme).toBeUndefined();
    expect(ws.sessions).toEqual([]);
    expect(ws.sources).toEqual([]);
    expect(ws.outputs.points).toEqual([]);
  });

  it("aggregates questions and debts by relatedThemeIds", () => {
    const s = createInitialProductState();
    const themeId = s.themes[0].id; // theme-control
    const ws = buildTrackWorkspace(s, themeId);
    ws.outputs.questions.forEach((q) => expect(q.relatedThemeIds).toContain(themeId));
    ws.outputs.debts.forEach((d) => expect(d.relatedThemeIds ?? []).toContain(themeId));
  });
});
