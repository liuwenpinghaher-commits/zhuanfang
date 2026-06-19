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
  it("aggregates sessions/outputs for a theme by relatedThemeIds; sources empty (no data link)", () => {
    const s = createInitialProductState();
    const themeId = s.themes[0].id;
    const ws = buildTrackWorkspace(s, themeId);
    expect(ws.theme?.id).toBe(themeId);
    expect(ws.sources).toEqual([]);
    ws.outputs.points.forEach((p) => expect(p.relatedThemeIds).toContain(themeId));
    ws.sessions.forEach((sess) => expect(sess.relatedThemeIds ?? []).toContain(themeId));
  });

  it("returns empty groups + undefined theme for unknown id", () => {
    const s = createInitialProductState();
    const ws = buildTrackWorkspace(s, "theme-does-not-exist");
    expect(ws.theme).toBeUndefined();
    expect(ws.sessions).toEqual([]);
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
