/**
 * 外部调研自动盯梢旅程
 *
 * 覆盖：
 *   1. 有简报时点「▶ 自动盯梢」→ 按钮进入 loading → 完成后显示"本次新增/刷新"汇总
 *   2. 空状态（无简报）时 CTA 可见（文案 + 空状态按钮）
 *   3. API 失败时显示错误 + 重试按钮可见
 *
 * 均用 page.route mock /api/research/auto-run，避免真实 LLM 调用。
 */
import { expect, test } from "@playwright/test";
import { createInitialProductState } from "../../src/domain/engine";
import { expectNoHorizontalOverflow, openView, resetDemoState } from "./helpers";

const AUTO_RUN_URL = "http://127.0.0.1:8787/api/research/auto-run";
const STATE_URL = "http://127.0.0.1:8787/api/state";

test("外部调研：自动盯梢完成后显示新增/刷新汇总", async ({ page }) => {
  await resetDemoState(page);

  // Mock auto-run to return immediately with a known summary
  await page.route(AUTO_RUN_URL, async (route) => {
    const cur = await (await page.request.get(STATE_URL)).json() as { revision?: number };
    const state = { ...createInitialProductState(), revision: (cur.revision ?? 0) + 1 };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        state,
        summary: { generated: 3, refreshed: 1, dedupedSources: 2 }
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
  // Seed a clean-start state (no searchBriefs) then navigate to 外部调研
  const base = "http://127.0.0.1:8787/api/state";
  const cur = await (await page.request.get(base)).json() as { revision?: number };
  const emptyState = {
    ...createInitialProductState(),
    searchBriefs: [],
    revision: cur.revision ?? 0
  };
  await page.request.put(base, { data: emptyState });
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

  // Mock auto-run to fail
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
