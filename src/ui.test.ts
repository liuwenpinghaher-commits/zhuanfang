import { describe, expect, it } from "vitest";
import {
  assetFilterOptions,
  buildNotice,
  configSectionOptions,
  formatCapabilityTaskStatus,
  formatRealtimePhase,
  formatPodcastTimestamp,
  groupedNavigation,
  interviewControlGroups,
  podcastProductionSections
} from "./ui";

describe("ui helpers", () => {
  it("groups top-level navigation into task-oriented sections", () => {
    expect(groupedNavigation.map((group) => group.label)).toEqual(["今日", "素材", "资产", "系统"]);
    expect(groupedNavigation.flatMap((group) => group.items.map((item) => item.id))).toEqual([
      "home",
      "interview",
      "search",
      "corpus",
      "podcast",
      "notes",
      "assets",
      "themes",
      "memory",
      "config",
      "profile"
    ]);
  });

  it("builds notices with stable aria-live friendly content", () => {
    const notice = buildNotice("success", "搜索简报已生成", "已自动选中新素材，可带入专访。");

    expect(notice.kind).toBe("success");
    expect(notice.message).toBe("搜索简报已生成");
    expect(notice.detail).toContain("专访");
    expect(notice.id).toMatch(/^notice-/);
  });

  it("defines asset workbench filters in a stable order", () => {
    expect(assetFilterOptions.map((option) => option.id)).toEqual(["all", "points", "questions", "decisions", "debts"]);
    expect(assetFilterOptions.find((option) => option.id === "points")?.label).toBe("观点");
  });

  it("defines system configuration sections in a stable order", () => {
    expect(configSectionOptions.map((option) => option.id)).toEqual(["overview", "providers", "policies", "patches"]);
    expect(configSectionOptions.find((option) => option.id === "providers")?.label).toBe("Provider");
  });

  it("groups in-session interview controls by user intent", () => {
    expect(interviewControlGroups.map((group) => group.label)).toEqual(["节奏", "方向", "边界"]);
    expect(interviewControlGroups.flatMap((group) => group.actions.map((action) => action.id))).toEqual([
      "softer",
      "summary",
      "different-angle",
      "sharper",
      "skip",
      "do-not-save"
    ]);
  });

  it("formats realtime phases into interview-facing states", () => {
    expect(formatRealtimePhase("listening")).toBe("正在听");
    expect(formatRealtimePhase("holding")).toBe("保持留白");
    expect(formatRealtimePhase("thinking")).toBe("整理追问");
    expect(formatRealtimePhase("speaking")).toBe("准备开场");
  });

  it("defines podcast production sections in workflow order", () => {
    expect(podcastProductionSections.map((section) => section.label)).toEqual([
      "制作设置",
      "收听复核",
      "章节导航",
      "Shownotes",
      "脚本复核"
    ]);
  });

  it("formats podcast timestamps for chapter navigation", () => {
    expect(formatPodcastTimestamp(0)).toBe("00:00");
    expect(formatPodcastTimestamp(45)).toBe("00:45");
    expect(formatPodcastTimestamp(185)).toBe("03:05");
  });

  it("formats capability task statuses for operator feedback", () => {
    expect(formatCapabilityTaskStatus("idle")).toBe("待开始");
    expect(formatCapabilityTaskStatus("running")).toBe("运行中");
    expect(formatCapabilityTaskStatus("succeeded")).toBe("已完成");
    expect(formatCapabilityTaskStatus("failed")).toBe("失败");
    expect(formatCapabilityTaskStatus("degraded")).toBe("降级完成");
    expect(formatCapabilityTaskStatus("cancelled")).toBe("已取消");
  });
});
