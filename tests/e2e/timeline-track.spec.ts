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

    // 继续这条线 CTA（主按钮在 header；空列可能另有次级按钮）
    await expect(page.getByRole("button", { name: /继续这条线/ }).first()).toBeVisible();
  });

  test("back button from track workspace returns to themes overview", async ({ page }) => {
    await resetDemoState(page);

    // 进入主题线工作区
    const firstChip = page.locator(".track-chip").filter({ hasNot: page.locator(".track-chip-add") }).first();
    await firstChip.click();
    await expect(page.getByRole("heading", { name: "历次专访" })).toBeVisible();

    // 点「返回」按钮 → 主题线总览（不是首页）
    await page.getByRole("button", { name: /返回/ }).click();

    await expect(page.getByRole("heading", { name: "看见反复主题和观点变化" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "主题线列表" })).toBeVisible();
  });

  test("themes page continues a concrete theme from list", async ({ page }) => {
    await resetDemoState(page);
    await page.locator(".nav-item", { hasText: "主题线" }).click();
    await expect(page.getByRole("heading", { name: "看见反复主题和观点变化" })).toBeVisible();

    const continueButtons = page.locator(".theme-next .secondary-action", { hasText: "继续这条线" });
    await expect(continueButtons.first()).toBeVisible();
    // 可能弹出「未完成专访」确认
    page.once("dialog", (dialog) => dialog.accept());
    await continueButtons.first().click();
    await expect(page.locator(".interview-layout, .interview-launch, .opening-hero").first()).toBeVisible({
      timeout: 15_000
    });
  });
});
