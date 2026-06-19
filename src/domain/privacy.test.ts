import { describe, it, expect } from "vitest";
import { buildPrivacyReport } from "./privacy";
import { createInitialProductState } from "./engine";

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
});
