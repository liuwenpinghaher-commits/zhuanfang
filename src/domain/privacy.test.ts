import { describe, it, expect } from "vitest";
import { buildPrivacyReport, createScopedPurge, type PurgeScope } from "./privacy";
import { createInitialProductState } from "./engine";
import type { InterviewSession } from "./types";

describe("buildPrivacyReport", () => {
  it("inventories the core data categories with counts", () => {
    const report = buildPrivacyReport(createInitialProductState(), "2026-06-19T00:00:00.000Z");
    const ids = report.inventory.map((item) => item.id);
    // 核心类别齐全
    expect(ids).toContain("profile");
    expect(ids).toContain("interviews");
    expect(ids).toContain("assets");
    expect(ids).toContain("memory");
    expect(ids).toContain("external_knowledge");
    // 每个类别都有非负计数 + 标签
    for (const item of report.inventory) {
      expect(typeof item.label).toBe("string");
      expect(item.count).toBeGreaterThanOrEqual(0);
    }
    expect(report.totalRecords).toBe(report.inventory.reduce((sum, item) => sum + item.count, 0));
  });

  it("no longer reports the removed intel category (R3)", () => {
    const report = buildPrivacyReport(createInitialProductState(), "2026-06-19T00:00:00.000Z");
    expect(report.inventory.map((item) => item.id)).not.toContain("intel");
  });

  it("includes longitudinal KPIs (Wave B/C)", () => {
    const report = buildPrivacyReport(createInitialProductState(), "2026-06-19T00:00:00.000Z");
    expect(report.longitudinal).toEqual(
      expect.objectContaining({
        openDebts: expect.any(Number),
        dueDecisions: expect.any(Number),
        contradictionPairs: expect.any(Number),
        appliedPatches: expect.any(Number),
        sensitiveMemories: expect.any(Number),
        activeThemes: expect.any(Number)
      })
    );
  });
});

describe("createScopedPurge", () => {
  function seedWithInterview(): ReturnType<typeof createInitialProductState> {
    const base = createInitialProductState();
    const session: InterviewSession = {
      ...base.sessions[0],
      id: "sess-purge-test",
      turns: [],
      controlActions: [],
      status: "active"
    } as InterviewSession;
    return { ...base, sessions: [session], notes: [] };
  }

  it("scope 'profile' clears only the profile and leaves interviews/assets intact", () => {
    const before = seedWithInterview();
    const result = createScopedPurge(before, "profile", "2026-06-20T00:00:00.000Z");
    expect(result.deletedScope).toBe<PurgeScope>("profile");
    // profile wiped to the empty identity
    expect(result.nextState.profile.name).toBe("");
    expect(result.nextState.profile.role).toBe("未设置");
    // other scopes untouched
    expect(result.nextState.sessions.length).toBe(before.sessions.length);
    expect(result.nextState.points.length).toBe(before.points.length);
    // deletedCount equals what the privacy report counts for that category
    const profileCount = buildPrivacyReport(before).inventory.find((i) => i.id === "profile")!.count;
    expect(result.deletedCount).toBe(profileCount);
  });

  it("scope 'interviews' clears sessions+notes only, preserving profile and assets", () => {
    const before = seedWithInterview();
    const result = createScopedPurge(before, "interviews", "2026-06-20T00:00:00.000Z");
    expect(result.nextState.sessions).toHaveLength(0);
    expect(result.nextState.notes).toHaveLength(0);
    expect(result.nextState.profile.name).toBe(before.profile.name);
    expect(result.nextState.points.length).toBe(before.points.length);
    expect(result.deletedCount).toBe(before.sessions.length + before.notes.length);
  });

  it("scope 'assets' clears points/questions/decisions/debts/themes only", () => {
    const before = seedWithInterview();
    const result = createScopedPurge(before, "assets", "2026-06-20T00:00:00.000Z");
    expect(result.nextState.points).toHaveLength(0);
    expect(result.nextState.questions).toHaveLength(0);
    expect(result.nextState.decisions).toHaveLength(0);
    expect(result.nextState.debts).toHaveLength(0);
    expect(result.nextState.themes).toHaveLength(0);
    expect(result.nextState.profile.name).toBe(before.profile.name);
    expect(result.nextState.sessions.length).toBe(before.sessions.length);
  });

  it("scope 'all' clears every personal category but keeps systemConfig", () => {
    const before = seedWithInterview();
    const result = createScopedPurge(before, "all", "2026-06-20T00:00:00.000Z");
    expect(result.nextState.profile.name).toBe("");
    expect(result.nextState.sessions).toHaveLength(0);
    expect(result.nextState.points).toHaveLength(0);
    expect(result.nextState.systemConfig).toEqual(before.systemConfig);
    expect(result.deletedScope).toBe<PurgeScope>("all");
  });

  it("is idempotent: purging an already-empty scope returns deletedCount 0 and no throw", () => {
    const before = seedWithInterview();
    const once = createScopedPurge(before, "interviews", "2026-06-20T00:00:00.000Z");
    const twice = createScopedPurge(once.nextState, "interviews", "2026-06-20T00:00:01.000Z");
    expect(twice.deletedCount).toBe(0);
    expect(twice.nextState.sessions).toHaveLength(0);
  });
});
