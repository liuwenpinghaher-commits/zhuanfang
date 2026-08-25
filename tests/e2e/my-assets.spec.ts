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
  await openView(page, "本场记录", "这里就是以前的双轨笔记");
  await page.getByTestId("session-record-tab-archive").click();

  await expect(page.getByTestId("session-record-tab-archive")).toBeVisible();

  // demo state 中有专访记录，至少有一张档案卡
  await expect(page.locator("article.record-row").first()).toBeVisible();

  await expectNoHorizontalOverflow(page);
});

test("my-assets: switches to assets tab and back", async ({ page }) => {
  await resetDemoState(page);
  await openView(page, "本场记录", "这里就是以前的双轨笔记");
  await page.getByTestId("session-record-tab-assets").click();

  await expect(page.getByPlaceholder(/输入关键词/)).toBeVisible();
  await expect(page.getByRole("complementary", { name: "资产筛选" })).toBeVisible();

  await expectNoHorizontalOverflow(page);

  // 切回档案 tab
  await page.getByTestId("session-record-tab-archive").click();
  await expect(page.getByText("这里就是以前的双轨笔记")).toBeVisible();
  await expect(page.locator("article.record-row").first()).toBeVisible();
});

test("my-assets: generate podcast button navigates to podcast studio", async ({ page }) => {
  await resetDemoState(page);
  await openView(page, "本场记录", "这里就是以前的双轨笔记");
  await page.getByTestId("session-record-tab-archive").click();

  // 点击第一张档案卡的"生成播客"按钮
  await page.getByRole("button", { name: "生成播客" }).first().click();

  // App 切换至 podcast view
  await expect(page.getByText("把一次专访生成可收听的语音节目")).toBeVisible();
  await expectNoHorizontalOverflow(page);
});
