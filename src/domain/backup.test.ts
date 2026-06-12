import { describe, it, expect } from "vitest";
import { buildBackupRestoreRehearsalReport } from "./backup";
import { createInitialProductState } from "./engine";

describe("backup", () => {
  it("builds rehearsal report from product state", () => {
    const state = createInitialProductState();
    const report = buildBackupRestoreRehearsalReport(state);
    expect(report.checks.length).toBeGreaterThan(0);
    expect(report.checks.every((c) => c.status !== undefined)).toBe(true);
    expect(report.package.stateDigest).toBe(report.package.restoredDigest);
    expect(report.summary.failed).toBe(0);
  });

  it("warns when object files must be backed up with JSON state", () => {
    const report = buildBackupRestoreRehearsalReport({
      ...createInitialProductState(),
      podcastEpisodes: [
        {
          id: "podcast-local-object",
          noteId: "note-seed-1",
          sourceType: "note" as const,
          sourceId: "note-seed-1",
          title: "本地对象播客",
          format: "solo" as const,
          voice: "longyuan_v3",
          status: "ready" as const,
          scriptReviewStatus: "用户确认" as const,
          durationSec: 60,
          script: "测试",
          chapters: [],
          audioUrl: "local-object://corpus-audio/example.mp3",
          audioRenderStatus: "rendered" as const,
          audioRenderMessage: "已生成。",
          shownotes: [],
          createdAt: "2026-06-11T00:00:00.000Z"
        }
      ]
    });
    expect(report.summary.warning).toBeGreaterThan(0);
  });

  it("flags provider secret markers in product data", () => {
    const report = buildBackupRestoreRehearsalReport({
      ...createInitialProductState(),
      profile: {
        ...createInitialProductState().profile,
        currentFocus: "误粘贴 DASHSCOPE_API_KEY=sk-test-secret"
      }
    });
    expect(report.package.providerSecretsExcluded).toBe(false);
  });
});
