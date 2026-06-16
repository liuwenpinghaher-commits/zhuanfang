import { expect, type Page } from "@playwright/test";
import { createInitialProductState } from "../../src/domain/engine";

export async function resetDemoState(page: Page) {
  // Restore a known demo baseline (createInitialProductState) via the Product API.
  // We must read the current revision first so the server's optimistic-concurrency check accepts the PUT.
  const base = "http://127.0.0.1:8787/api/state";
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
