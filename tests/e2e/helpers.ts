import { expect, type Page } from "@playwright/test";
import { createInitialProductState } from "../../src/domain/engine";

export async function resetDemoState(page: Page) {
  // Restore a known demo baseline (createInitialProductState) via the Product API.
  // We must read the current revision first so the server's optimistic-concurrency check accepts the PUT.
  // B 类修正(规格陈旧,2026-07-10):自 828abea9「固定端口」起 API 固定在 3210(见 playwright.config
  // webServer 与 src/api/productApi.ts 的默认 base),这里残留的 8787 让 PUT 永远打空、被 catch 吞掉,
  // 种子从未真正落库——各 spec 实际跑在上一个 spec 留下的残留状态上。改回真实端口恢复本函数的本意。
  const base = "http://127.0.0.1:3210/api/state";
  try {
    const cur = await (await page.request.get(base)).json() as { revision?: number };
    const demoState = { ...createInitialProductState(), revision: cur.revision ?? 0 };
    await page.request.put(base, { data: demoState });
  } catch {
    // API may be down (e.g. intercepted by page.route); localStorage path below still works for mock flows.
  }
  await page.goto("/");
  await page.evaluate(() => window.localStorage.clear());
  await page.reload();
  await expect(page.getByRole("button", { name: "今日访谈台" })).toBeVisible();
}

/**
 * 统一的真后端重置入口(审计 F-08)。
 *
 * 为什么必须经这里:POST /api/state/reset 自上一轮审计 F-05 起要求 body
 * { confirm: "RESET_ALL_DATA" }(防 CSRF/误触),裸 POST 会 422——真实旅程从第一步
 * 就失败。契约再变时只改这一处;apps/api/src/e2e-contract.test.ts 的防回归扫描
 * 会钉死"spec 不得绕过 helper 直拼 reset 请求"。
 *
 * 刻意不对响应体形状做窄断言(后续任务可能给 reset 响应加附加字段):只验 HTTP ok,
 * 失败时抛出带状态码与响应体的错误方便定位,成功则返回解析后的 JSON 供调用方按需使用。
 */
export async function resetServerState(page: Page, apiBase: string): Promise<unknown> {
  const res = await page.request.post(`${apiBase}/api/state/reset`, {
    data: { confirm: "RESET_ALL_DATA" }
  });
  if (!res.ok()) {
    throw new Error(`reset 失败: HTTP ${res.status()} — ${await res.text()}`);
  }
  return res.json();
}

export async function openView(page: Page, navName: string, expectedText: string) {
  await page.getByRole("button", { name: navName }).click();
  await expect(page.getByText(expectedText)).toBeVisible();
}

export async function expectNoHorizontalOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
}

export async function useMobileViewport(page: Page) {
  await page.setViewportSize({ width: 390, height: 844 });
}
