import { expect, test } from "@playwright/test";
import { resetDemoState } from "./helpers";

test.describe("timeline and track workspace journeys", () => {
  test("home shows timeline section and at least one track chip", async ({ page }) => {
    await resetDemoState(page);

    // 时间轴区域标题可见
    await expect(page.getByRole("heading", { name: "时间轴" })).toBeVisible();

    // 至少有一个主题线卡片
    const chips = page.locator(".track-chip").filter({ hasNot: page.locator(".track-chip-add") });
    await expect(chips.first()).toBeVisible();
  });

  test("clicking a track chip navigates to track workspace with three columns and CTA", async ({ page }) => {
    await resetDemoState(page);

    // 点击第一个主题线卡(排除"新建主题线"按钮)
    const firstChip = page.locator(".track-chip").filter({ hasNot: page.locator(".track-chip-add") }).first();
    await firstChip.click();

    // 三列标题
    await expect(page.getByRole("heading", { name: "资料来源" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "历次专访" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "沉淀产出" })).toBeVisible();

    // 继续这条线 CTA
    await expect(page.getByRole("button", { name: /继续这条线/ })).toBeVisible();
  });

  test("back button from track workspace returns to home timeline", async ({ page }) => {
    await resetDemoState(page);

    // 进入主题线工作区
    const firstChip = page.locator(".track-chip").filter({ hasNot: page.locator(".track-chip-add") }).first();
    await firstChip.click();
    await expect(page.getByRole("heading", { name: "历次专访" })).toBeVisible();

    // 点「返回」按钮
    await page.getByRole("button", { name: /返回/ }).click();

    // 回到首页：时间轴再次可见
    await expect(page.getByRole("heading", { name: "时间轴" })).toBeVisible();
  });
});
