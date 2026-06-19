/**
 * P4-T2 regression: "清空示例，开始我的记录" (clean-start feature).
 *
 * Regression for the crash bug that occurred when 清空示例 was clicked and the
 * app tried to render views with an empty ProductState. Tests:
 *   1. Clears demo data via the 个人档案 danger-zone button (window.confirm accepted).
 *   2. App does NOT blank-screen after clearing.
 *   3. Empty-state copies render correctly in 今日访谈台, 双轨笔记, 资产库.
 *   4. User can still start a fresh interview from the empty state.
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
  // ProfileView renders the button with text "清空示例，开始我的记录".
  // App.resetData uses window.confirm, so we must intercept with page.on("dialog").
  page.on("dialog", async (dialog) => {
    await dialog.accept();
  });

  await page.getByRole("button", { name: "清空示例，开始我的记录" }).click();

  // App shows a success notice after clearing.
  await expect(page.getByText("示例数据已清空")).toBeVisible();

  // App navigates to home view ("home") after reset.
  // The nav button "今日访谈台" must be visible — proves no blank-screen crash.
  await expect(page.getByRole("button", { name: "今日访谈台" })).toBeVisible();

  // ── Step 3: home view renders in empty state without crashing ─────────────
  // With no themes, HomeView shows empty-hint: "还没有长期主题，开始第一次专访后会自动出现在这里。"
  await expect(page.getByText("还没有长期主题")).toBeVisible();

  // ── Step 4: 双轨笔记 view — no notes, no crash ────────────────────────────
  await page.getByRole("button", { name: "双轨笔记" }).click();
  await expect(page.getByText("从访谈沉淀认知资产")).toBeVisible();
  // No note cards should be present (empty state — the record-list exists but empty).
  await expect(page.locator("article.record-row")).toHaveCount(0);

  // ── Step 5: 资产库 view — empty state, no crash ───────────────────────────
  await page.getByRole("button", { name: "资产库" }).click();
  await expect(page.getByText("观点、问题、决策和知识债")).toBeVisible();
  // AssetsView shows "当前筛选下没有资产" when empty.
  await expect(page.getByText("当前筛选下没有资产。")).toBeVisible();

  // ── Step 6: can still start a fresh interview from empty state ────────────
  // Navigate back to home, click "开始聊这个".
  await page.getByRole("button", { name: "今日访谈台" }).click();
  await page.getByRole("button", { name: "开始聊这个" }).click();

  // P2-16: one-click start — from the empty state this creates a session and enters the live
  // interview directly (no "专访启动" screen). Proves a fresh interview is usable after clearing.
  await expect(page.getByText("实时专访")).toBeVisible();
  await expect(page.getByLabel("你的回答")).toBeVisible();
});
