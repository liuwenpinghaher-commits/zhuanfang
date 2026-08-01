/**
 * P4-T2 regression: "清空全部数据，从头开始" (clean-start feature；原名"清空示例，开始我的记录",
 * 审计「reset 文案如实」后按钮/通知文案已如实化).
 *
 * Regression for the crash bug that occurred when 清空示例 was clicked and the
 * app tried to render views with an empty ProductState. Tests:
 *   1. Clears demo data via the 个人档案 danger-zone button (window.confirm accepted).
 *   2. App does NOT blank-screen after clearing.
 *   3. Empty-state copies render correctly in 今日访谈台, 我的资产(档案tab), 我的资产(资产tab).
 *   4. User can still start a fresh interview from the empty state.
 *
 * R2 导航更新: 双轨笔记/资产库 已并入"我的资产"(archive/assets tab)。
 */
import { expect, test } from "@playwright/test";
import { resetDemoState } from "./helpers";

test("清空示例 clears demo data and leaves app usable", async ({ page }) => {
  // Seed demo baseline so there is definitely data to clear.
  await resetDemoState(page);

  // ── Step 1: navigate to 个人档案 ──────────────────────────────────────────
  await page.getByRole("button", { name: "个人档案" }).click();
  await expect(page.getByText("长期记忆必须可见、可修正、可删除。AI 推断不能直接等同于事实。")).toBeVisible();

  // ── Step 2: register dialog handler BEFORE clicking, then click ───────────
  // B 类修正(规格陈旧,2026-07-10):审计「reset 文案如实」(B11/B12,F-03 延续)把按钮从
  // “清空示例，开始我的记录”改为“清空全部数据，从头开始”、成功通知从“示例数据已清空”改为
  // “全部数据已清空”——reset 删除的是全部数据(含用户真实记录),旧文案会误导用户。断言跟上新文案。
  // App.resetData uses window.confirm, so we must intercept with page.on("dialog").
  page.on("dialog", async (dialog) => {
    await dialog.accept();
  });

  await page.getByRole("button", { name: "清空全部数据，从头开始" }).click();

  // App shows a success notice after clearing (F-03:该文案只在服务端确认全部清空时出现)。
  await expect(page.getByText("全部数据已清空")).toBeVisible();

  // App navigates to home view ("home") after reset.
  // The nav button "今日访谈台" must be visible — proves no blank-screen crash.
  await expect(page.getByRole("button", { name: "今日访谈台" })).toBeVisible();

  // ── Step 3: home view renders in empty state without crashing ─────────────
  // With no themes, HomeView shows empty-hint: "还没有主题线，完成专访后会自动浮现。"
  await expect(page.getByText("还没有主题线，完成专访后会自动浮现。")).toBeVisible();

  // ── Step 4: 我的资产 → 档案 tab — no archive entries, no crash ────────────
  // R2: 双轨笔记/资产库 已并入"我的资产"(archive/assets tab)，无独立导航按钮。
  await page.getByRole("button", { name: "我的资产" }).click();
  await expect(page.getByText("专访档案与认知资产库")).toBeVisible();
  // 档案 tab 为默认 tab；清空后无档案条目。
  await expect(page.locator("article.record-row")).toHaveCount(0);

  // ── Step 5: 我的资产 → 资产 tab — empty state, no crash ─────────────────
  await page.getByRole("button", { name: "资产库" }).click();
  // Embedded AssetsView: no nested page H1; search + filter landmarks confirm the tab.
  await expect(page.getByPlaceholder(/输入关键词/)).toBeVisible();
  await expect(page.getByRole("complementary", { name: "资产筛选" })).toBeVisible();
  // AssetsView shows "当前筛选下没有资产" when empty.
  await expect(page.getByText("当前筛选下没有资产。")).toBeVisible();

  // ── Step 6: can still start a fresh interview from empty state ────────────
  // Navigate back to home, click "一键开始".
  await page.getByRole("button", { name: "今日访谈台" }).click();
  await page.getByRole("button", { name: "一键开始" }).click();

  // P2-16: one-click start — from the empty state this creates a session and enters the live
  // interview directly (no "专访启动" screen). Proves a fresh interview is usable after clearing.
  await expect(page.getByText("实时专访")).toBeVisible();
  await expect(page.getByLabel("你的回答")).toBeVisible();
});
