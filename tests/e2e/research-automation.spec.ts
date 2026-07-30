/**
 * 外部调研自动盯梢旅程
 *
 * 覆盖：
 *   1. 有简报时点「▶ 自动盯梢」→ 按钮进入 loading → 完成后显示"本次新增/刷新"汇总
 *   2. 空状态（无简报、无认知资产）时 CTA 可见（文案 + 空状态按钮）
 *   3. API 失败时显示错误 + 重试按钮可见
 *
 * 契约说明（真实性重构后）：
 *   - auto-run 不再产 local-demo 占位简报；单条失败进 summary.failures（summary.failed 计数），
 *     成功时走真实生成（E2E 默认族由 fake provider 承接外部网络）。
 *   - 前端"打开即更新"：首次进入外部调研视图会静默触发一次 auto-run。
 *   - 用例 1/3 用 page.route mock /api/research/auto-run（真实端口 3210）以获得确定性的
 *     汇总数字/失败路径；用例 2 需要空议程（无主题/知识债/决策/已确认记忆），否则
 *     "打开即更新"会真实生成简报、空状态消失。
 */
import { expect, test } from "@playwright/test";
import { createEmptyProductState, createInitialProductState } from "../../src/domain/engine";
import { expectNoHorizontalOverflow, openView, resetDemoState } from "./helpers";

const AUTO_RUN_URL = "http://127.0.0.1:13210/api/research/auto-run";
const STATE_URL = "http://127.0.0.1:13210/api/state";

test("外部调研：自动盯梢完成后显示新增/刷新汇总", async ({ page }) => {
  await resetDemoState(page);

  // Mock auto-run to return immediately with a known summary（含新契约字段 failed）
  await page.route(AUTO_RUN_URL, async (route) => {
    const cur = await (await page.request.get(STATE_URL)).json() as { revision?: number };
    const state = { ...createInitialProductState(), revision: (cur.revision ?? 0) + 1 };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        state,
        summary: { generated: 3, refreshed: 1, dedupedSources: 2, failed: 0 }
      })
    });
  });

  await openView(page, "外部调研", "主动搜集热点、素材和可讨论主题");

  // 主操作面板里的"▶ 自动盯梢"按钮应可见
  const autoWatchBtn = page.getByRole("button", { name: /自动盯梢/ }).first();
  await expect(autoWatchBtn).toBeVisible();

  // 点击自动盯梢
  await autoWatchBtn.click();

  // 汇总文本：view 内显示"本次新增 3 条 · 刷新 1 条"，或 notice 中"新增 3 条，刷新 1 条"
  // 使用精确匹配 view 内的汇总文本避免 strict mode violation
  await expect(page.getByText(/本次新增.*条.*刷新.*条/)).toBeVisible({ timeout: 10000 });
  // 确认具体数字可读取（first() 避免匹配 notice 和 view 两处）
  await expect(page.getByText(/本次新增 3 条/).first()).toBeVisible();
  await expect(page.getByText(/刷新 1 条/).first()).toBeVisible();

  await expectNoHorizontalOverflow(page);
});

test("外部调研：空状态 CTA 可见（无简报时提示使用自动盯梢）", async ({ page }) => {
  // 空状态要成立必须议程为空：createEmptyProductState()（无主题/知识债/决策/已确认记忆）。
  // 若只清 searchBriefs 而保留 demo 认知资产，"打开即更新"会真实生成简报、空状态消失。
  const cur = await (await page.request.get(STATE_URL)).json() as { revision?: number };
  const emptyState = {
    ...createEmptyProductState(),
    revision: cur.revision ?? 0
  };
  const put = await page.request.put(STATE_URL, { data: emptyState });
  expect(put.ok()).toBe(true);
  await page.goto("/");
  await page.evaluate(() => window.localStorage.clear());
  await page.reload();
  await expect(page.getByRole("button", { name: "今日访谈台" })).toBeVisible();

  await openView(page, "外部调研", "主动搜集热点、素材和可讨论主题");

  // 空状态提示文案
  await expect(page.getByText("还没有搜索简报。点「自动盯梢」，从你的主题和知识债自动采集情报。")).toBeVisible();

  // 空状态内的"自动盯梢"CTA 按钮可见
  await expect(page.getByRole("button", { name: "自动盯梢" }).first()).toBeVisible();

  await expectNoHorizontalOverflow(page);
});

test("外部调研：自动盯梢 API 失败时显示错误信息和重试按钮", async ({ page }) => {
  await resetDemoState(page);

  // Mock auto-run to fail（"打开即更新"的静默首跑同样命中此 mock，静默失败不打扰）
  await page.route(AUTO_RUN_URL, async (route) => {
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "Internal Server Error" })
    });
  });

  await openView(page, "外部调研", "主动搜集热点、素材和可讨论主题");

  const autoWatchBtn = page.getByRole("button", { name: /自动盯梢/ }).first();
  await autoWatchBtn.click();

  // 错误状态：显示错误文案（App 里 catch 抛出 "自动盯梢失败，请检查网络连接后重试"）
  await expect(page.getByText(/运行失败|自动盯梢失败/)).toBeVisible({ timeout: 10000 });

  // 重试按钮可见
  await expect(page.getByRole("button", { name: "重试" })).toBeVisible();

  await expectNoHorizontalOverflow(page);
});
