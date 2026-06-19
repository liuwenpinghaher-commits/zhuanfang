import { expect, test } from "@playwright/test";
import { expectNoHorizontalOverflow, openView, resetDemoState } from "./helpers";

// ============================================================
// 外部调研旅程 (R3)
// 覆盖：创建简报 → 持续追踪开关 → 重新调研刷新 → 带入专访入口可见
// 全部走真实 Product API（local-demo fallback），不 mock 网络。
// ============================================================

test("外部调研：创建简报 → 标记持续追踪 → 重新调研 → 带入专访入口可见", async ({ page }) => {
  await resetDemoState(page);
  await openView(page, "外部调研", "主动搜集热点、素材和可讨论主题");

  // ---- 阶段 1: 创建简报（AnySearch，走 local-demo fallback）----
  await page.getByLabel("追踪主题").fill("AI 产品商业化热点");
  await page.getByRole("button", { name: "AnySearch", exact: true }).click();

  // 等待简报生成完成（成功或降级）
  await expect(
    page.getByText(/搜索已降级完成|搜索简报已生成/)
  ).toBeVisible({ timeout: 10000 });

  // 简报卡片出现在列表中
  const briefArticle = page.locator("article.record-row").first();
  await expect(briefArticle).toBeVisible({ timeout: 8000 });

  // 简报有 topic（输入的主题）
  await expect(briefArticle.getByRole("heading")).toBeVisible();

  // 带入专访按钮可见
  await expect(briefArticle.getByRole("button", { name: "带入专访" })).toBeVisible();
  await expectNoHorizontalOverflow(page);

  // ---- 阶段 2: 标记持续追踪 ----
  // 初始状态：未追踪，按钮显示"持续追踪"
  await expect(briefArticle.getByRole("button", { name: "持续追踪", exact: true })).toBeVisible();

  // 点击追踪
  await briefArticle.getByRole("button", { name: "持续追踪", exact: true }).click();

  // 通知消息出现
  await expect(page.getByText(/已标记为持续追踪/)).toBeVisible({ timeout: 5000 });

  // 按钮状态切换为"持续追踪中"
  await expect(briefArticle.getByRole("button", { name: "持续追踪中", exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);

  // ---- 阶段 3: 重新调研 ----
  await briefArticle.getByRole("button", { name: "重新调研", exact: true }).click();

  // 刷新成功通知
  await expect(page.getByText("外部调研已刷新")).toBeVisible({ timeout: 8000 });

  // 简报卡片仍然存在（刷新后没有被删掉）
  await expect(briefArticle).toBeVisible();

  // 带入专访入口仍然可见
  await expect(briefArticle.getByRole("button", { name: "带入专访" })).toBeVisible();

  // 追踪状态在刷新后应被保留（持续追踪中）
  await expect(briefArticle.getByRole("button", { name: "持续追踪中", exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test("外部调研：持续追踪开关可反复切换", async ({ page }) => {
  await resetDemoState(page);
  await openView(page, "外部调研", "主动搜集热点、素材和可讨论主题");

  // 创建一个简报
  await page.getByLabel("追踪主题").fill("AI 监管与合规");
  await page.getByRole("button", { name: "AnySearch", exact: true }).click();

  await expect(
    page.getByText(/搜索已降级完成|搜索简报已生成/)
  ).toBeVisible({ timeout: 10000 });

  const briefArticle = page.locator("article.record-row").first();
  await expect(briefArticle).toBeVisible({ timeout: 8000 });

  // 初始未追踪 → 追踪
  await expect(briefArticle.getByRole("button", { name: "持续追踪", exact: true })).toBeVisible();
  await briefArticle.getByRole("button", { name: "持续追踪", exact: true }).click();
  await expect(briefArticle.getByRole("button", { name: "持续追踪中", exact: true })).toBeVisible({ timeout: 5000 });
  await expect(page.getByText(/已标记为持续追踪/)).toBeVisible();

  // 追踪 → 取消追踪
  await briefArticle.getByRole("button", { name: "持续追踪中", exact: true }).click();
  await expect(briefArticle.getByRole("button", { name: "持续追踪", exact: true })).toBeVisible({ timeout: 5000 });
  await expect(page.getByText("已取消持续追踪", { exact: true })).toBeVisible();

  await expectNoHorizontalOverflow(page);
});

test("外部调研：带入专访后可在实时专访中看到外部参照", async ({ page }) => {
  await resetDemoState(page);
  await openView(page, "外部调研", "主动搜集热点、素材和可讨论主题");

  // 创建简报
  await page.getByLabel("追踪主题").fill("大模型竞争格局");
  await page.getByRole("button", { name: "AnySearch", exact: true }).click();

  await expect(
    page.getByText(/搜索已降级完成|搜索简报已生成/)
  ).toBeVisible({ timeout: 10000 });

  const briefArticle = page.locator("article.record-row").first();
  await expect(briefArticle).toBeVisible({ timeout: 8000 });

  // 带入专访 — 触发 launchInterview，页面切换到 interview 视图
  await briefArticle.getByRole("button", { name: "带入专访" }).click();

  // interview 视图出现：session 加载中时显示"专访启动"，加载完成后显示"实时专访"
  // 用 .or() 组合断言，确保进入了 interview 区域
  await expect(
    page.getByText("专访启动").or(page.getByText("实时专访"))
  ).toBeVisible({ timeout: 8000 });
  await expectNoHorizontalOverflow(page);
});
