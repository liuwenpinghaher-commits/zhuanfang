import { describe, it, expect } from "vitest";
import { assessStateExportCompleteness, buildBackupRestoreRehearsalReport } from "./backup";
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

  it("将无遗漏且不超导入上限的导出判为完整、可直接导入", () => {
    expect(
      assessStateExportCompleteness({
        audioSessions: ["s1"],
        audios: [{ sessionId: "s1" }],
        audioOmittedSessions: [],
        importCompatibility: { bytes: 1024, importBodyLimitBytes: 2048, exceedsImportLimit: false }
      })
    ).toEqual({
      status: "complete",
      complete: true,
      directlyImportable: true,
      reasons: [],
      audioSessions: 1,
      includedAudioSessions: 1,
      omittedAudioSessions: 0,
      failedChecks: 0,
      externalArtifactWarnings: 0
    });
  });

  it("音频被预算省略时判为 partial，并明确遗漏数量", () => {
    const assessment = assessStateExportCompleteness({
      audioSessions: ["s1", "s2"],
      audios: [{ sessionId: "s1" }],
      audioOmittedSessions: ["s2"],
      importCompatibility: { bytes: 1024, importBodyLimitBytes: 2048, exceedsImportLimit: false }
    });
    expect(assessment.status).toBe("partial");
    expect(assessment.complete).toBe(false);
    expect(assessment.directlyImportable).toBe(true);
    expect(assessment.omittedAudioSessions).toBe(1);
    expect(assessment.reasons[0]).toContain("1 段录音");
  });

  it("包体超过 import body limit 时优先判为 not-directly-importable", () => {
    const assessment = assessStateExportCompleteness({
      audioSessions: ["s1"],
      audios: [],
      audioOmittedSessions: ["s1"],
      importCompatibility: { bytes: 4096, importBodyLimitBytes: 2048, exceedsImportLimit: true }
    });
    expect(assessment.status).toBe("not-directly-importable");
    expect(assessment.complete).toBe(false);
    expect(assessment.directlyImportable).toBe(false);
    expect(assessment.reasons.join(" ")).toContain("导入上限");
  });

  it("audioSessions 有声明但既未打包也未列 omitted 时仍判 partial", () => {
    const assessment = assessStateExportCompleteness({
      audioSessions: ["declared-but-missing"],
      audios: [],
      audioOmittedSessions: [],
      importCompatibility: { bytes: 1024, importBodyLimitBytes: 2048, exceedsImportLimit: false }
    });
    expect(assessment.status).toBe("partial");
    expect(assessment.omittedAudioSessions).toBe(1);
    expect(assessment.reasons.join(" ")).toContain("未打包");
  });

  it("local-object 原件未随 JSON 打包时判 partial；演练 failed 时阻断直接导入", () => {
    const baseInput = {
      audioSessions: [],
      audios: [],
      audioOmittedSessions: [],
      importCompatibility: { bytes: 1024, importBodyLimitBytes: 2048, exceedsImportLimit: false }
    };
    const localObject = assessStateExportCompleteness({
      ...baseInput,
      checks: [{
        id: "local-object-artifacts",
        label: "对象文件跟随备份",
        status: "warning" as const,
        detail: "发现 2 个 local-object:// 引用。",
        recommendation: "同步备份对象原件。"
      }]
    });
    expect(localObject.status).toBe("partial");
    expect(localObject.externalArtifactWarnings).toBe(1);

    const failed = assessStateExportCompleteness({
      ...baseInput,
      checks: [{
        id: "provider-secrets",
        label: "Provider 密钥排除",
        status: "failed" as const,
        detail: "导出包疑似包含 secret。",
        recommendation: "移除 secret。"
      }]
    });
    expect(failed.status).toBe("not-directly-importable");
    expect(failed.failedChecks).toBe(1);
    expect(failed.reasons.join(" ")).toContain("Provider 密钥排除");
  });
});
