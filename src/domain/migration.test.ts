import { describe, it, expect } from "vitest";
import { buildProductStateMigrationManifest } from "./migration";
import { createInitialProductState } from "./engine";

describe("migration", () => {
  it("builds migration manifest", () => {
    const state = createInitialProductState();
    const manifest = buildProductStateMigrationManifest(state);
    expect(manifest.entityCounts.length).toBeGreaterThan(0);
    expect(manifest.checks.length).toBeGreaterThan(0);
    expect(manifest.recommendedTarget).toBe("postgres-jsonb-first");
    expect(manifest.sourceTables).toContain("product_state_snapshots");
  });

  it("reports pending memory candidates as a migration warning", () => {
    const state = {
      ...createInitialProductState(),
      memoryCandidates: [
        {
          id: "memory-candidate-pending",
          text: "用户正在把专访系统作为长期认知资产库使用。",
          status: "pending" as const,
          sourceType: "manual_correction" as const,
          sourceId: "manual",
          evidenceQuote: "作为长期认知资产库使用",
          reason: "需要用户确认后才能进入长期记忆。",
          sensitivity: "normal" as const,
          reviewScore: 84,
          reviewSignals: ["显式偏好"],
          createdAt: "2026-06-11T00:00:00.000Z"
        }
      ]
    };
    const manifest = buildProductStateMigrationManifest(state);
    expect(manifest.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "pending-memory-review",
          status: "warning"
        })
      ])
    );
  });

  it("includes intel entity counts in migration manifest", () => {
    const state = {
      ...createInitialProductState(),
      intelTasks: [
        {
          id: "intel-task-1",
          name: "AI 行业动态",
          keywords: ["AI"],
          provider: "local-demo" as const,
          frequency: "weekly" as const,
          relatedThemeIds: [],
          relatedDebtIds: [],
          status: "active" as const,
          createdAt: "2026-06-19T00:00:00.000Z"
        }
      ],
      intelItems: [
        {
          id: "intel-item-1",
          taskId: "intel-task-1",
          taskName: "AI 行业动态",
          title: "GPT-5 发布",
          url: "https://example.com/gpt5",
          publisher: "OpenAI Blog",
          summary: "GPT-5 正式发布。",
          relevance: 92,
          claims: [],
          category: "模型发布",
          status: "unread" as const,
          topic: "LLM 进展",
          createdAt: "2026-06-19T00:00:00.000Z"
        }
      ]
    };
    const manifest = buildProductStateMigrationManifest(state);
    const intelEntry = manifest.entityCounts.find((e) => e.id === "intel");
    expect(intelEntry).toBeDefined();
    expect(intelEntry?.count).toBe(2); // 1 task + 1 item
  });

  it("reports local object audio as a migration warning", () => {
    const state = {
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
    };
    const manifest = buildProductStateMigrationManifest(state);
    expect(manifest.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "local-object-audio",
          status: "warning"
        })
      ])
    );
  });
});
