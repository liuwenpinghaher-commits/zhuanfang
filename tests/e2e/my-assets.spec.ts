/**
 * R2 新旅程: 我的资产视图 (my-assets)
 *
 * 覆盖:
 *   1. 进入"我的资产" → 默认显示档案 tab（专访档案）
 *   2. demo state 中含专访档案条目，archive card 可见
 *   3. 切换至"资产库" tab → 资产列表区可见（AssetsView header / 筛选器）
 *   4. 切回档案 tab → 档案内容仍可见
 *   5. 档案卡片"生成播客"按钮跳转至播客工作台
 */
import { expect, test } from "@playwright/test";
import { expectNoHorizontalOverflow, openView, resetDemoState } from "./helpers";

test("my-assets: archive tab is default and shows demo entries", async ({ page }) => {
  await resetDemoState(page);
  await openView(page, "我的资产", "专访档案与认知资产库");

  // 默认打开档案 tab
  await expect(page.getByRole("button", { name: /专访档案/ })).toBeVisible();

  // demo state 中有专访记录，至少有一张档案卡
  await expect(page.locator("article.record-row").first()).toBeVisible();

  await expectNoHorizontalOverflow(page);
});

test("my-assets: switches to assets tab and back", async ({ page }) => {
  await resetDemoState(page);
  await openView(page, "我的资产", "专访档案与认知资产库");

  // 切换到资产库 tab
  await page.getByRole("button", { name: "资产库" }).click();

  // AssetsView renders h1 "观点、问题、决策和知识债" (use heading role to avoid subtitle collision)
  await expect(page.getByRole("heading", { name: "观点、问题、决策和知识债" })).toBeVisible();
  // 搜索框可见
  await expect(page.getByPlaceholder(/输入关键词/)).toBeVisible();

  await expectNoHorizontalOverflow(page);

  // 切回档案 tab
  await page.getByRole("button", { name: /专访档案/ }).click();
  await expect(page.getByText("专访档案与认知资产库")).toBeVisible();
  await expect(page.locator("article.record-row").first()).toBeVisible();
});

test("my-assets: generate podcast button navigates to podcast studio", async ({ page }) => {
  await resetDemoState(page);
  await openView(page, "我的资产", "专访档案与认知资产库");

  // 点击第一张档案卡的"生成播客"按钮
  await page.getByRole("button", { name: "生成播客" }).first().click();

  // App 切换至 podcast view
  await expect(page.getByText("把一次专访生成可收听的语音节目")).toBeVisible();
  await expectNoHorizontalOverflow(page);
});
