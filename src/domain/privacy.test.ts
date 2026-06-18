import { describe, it, expect } from "vitest";
import { buildPrivacyReport } from "./privacy";
import { createInitialProductState } from "./engine";

describe("buildPrivacyReport", () => {
  it("includes intel category in inventory with correct count", () => {
    const state = {
      ...createInitialProductState(),
      intelTasks: [
        {
          id: "intel-task-1",
          name: "AI 行业动态",
          keywords: ["AI", "LLM"],
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
          claims: ["性能提升 50%"],
          category: "模型发布",
          status: "unread" as const,
          topic: "LLM 进展",
          createdAt: "2026-06-19T00:00:00.000Z"
        },
        {
          id: "intel-item-2",
          taskId: "intel-task-1",
          taskName: "AI 行业动态",
          title: "Anthropic 融资",
          url: "https://example.com/anthropic",
          publisher: "TechCrunch",
          summary: "Anthropic 完成新一轮融资。",
          relevance: 80,
          claims: [],
          category: "投融资",
          status: "saved" as const,
          topic: "AI 公司动态",
          createdAt: "2026-06-19T00:00:00.000Z"
        }
      ]
    };

    const report = buildPrivacyReport(state);
    const intelEntry = report.inventory.find((item) => item.id === "intel");

    expect(intelEntry).toBeDefined();
    expect(intelEntry?.count).toBe(3); // 1 task + 2 items
    expect(intelEntry?.exported).toBe(true);
    expect(intelEntry?.purged).toBe(true);
  });

  it("includes intel in totalRecords", () => {
    const emptyState = createInitialProductState();
    const baseReport = buildPrivacyReport(emptyState);

    const stateWithIntel = {
      ...emptyState,
      intelTasks: [
        {
          id: "intel-task-2",
          name: "科技资讯",
          keywords: ["科技"],
          provider: "local-demo" as const,
          frequency: "daily" as const,
          relatedThemeIds: [],
          relatedDebtIds: [],
          status: "active" as const,
          createdAt: "2026-06-19T00:00:00.000Z"
        }
      ],
      intelItems: []
    };
    const reportWithIntel = buildPrivacyReport(stateWithIntel);

    expect(reportWithIntel.totalRecords).toBe(baseReport.totalRecords + 1);
  });
});
