import { expect, type Page } from "@playwright/test";

export async function resetDemoState(page: Page) {
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
