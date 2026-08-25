import { expect, test, type Page } from "@playwright/test";
import { openView, resetDemoState } from "./helpers";

/**
 * Full-shell visual regression across primary nav views × light/dark themes.
 * Baselines live in tests/e2e/visual-regression.spec.ts-snapshots/.
 * Update: npx playwright test tests/e2e/visual-regression.spec.ts --update-snapshots
 */

const views = [
  ["今日访谈台", "一键开始", "home"],
  ["实时专访", "还没有正在进行的专访", "interview"],
  ["主题线", "看见反复主题和观点变化", "themes"],
  ["本场记录", "这里就是以前的双轨笔记", "notes"],
  ["记忆", "点头之后，下场才认", "memory"],
  ["资料", "放进我的书，或问我的书", "asset-chat"],
  ["外部调研", "主动搜集热点、素材和可讨论主题", "search"],
  ["系统配置", "状态页展示能力健康", "config"],
  ["个人档案", "产品负责人 · AI 产品 / 创业", "profile"]
] as const;

type ThemeMode = "light" | "dark";

async function applyTheme(page: Page, theme: ThemeMode) {
  await page.evaluate((mode) => {
    localStorage.setItem("zhuanfang.color-theme", mode);
    document.documentElement.dataset.theme = mode;
    document.documentElement.style.colorScheme = mode;
  }, theme);
  await page.reload();
  await expect(page.getByRole("button", { name: "今日访谈台" })).toBeVisible();
  await expect
    .poll(async () => page.locator("html").getAttribute("data-theme"))
    .toBe(theme);
}

async function settleVisual(page: Page) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  // Fonts + layout settle before snapshot.
  await page.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fonts = (document as any).fonts;
    if (fonts?.ready) await fonts.ready;
  });
  await page.waitForTimeout(120);
}

test.describe("visual regression · shell themes", () => {
  test.describe.configure({ mode: "serial" });

  for (const theme of ["light", "dark"] as const) {
    test(`${theme} theme · all primary views`, async ({ page }) => {
      test.setTimeout(180_000);
      await page.setViewportSize({ width: 1440, height: 960 });
      await resetDemoState(page);
      await applyTheme(page, theme);

      for (const [navName, expectedText, slug] of views) {
        await openView(page, navName, expectedText);
        await settleVisual(page);
        await expect(page).toHaveScreenshot(`${slug}-${theme}.png`, {
          fullPage: true,
          animations: "disabled",
          caret: "hide",
          // Allow minor AA/font raster differences across machines.
          maxDiffPixelRatio: 0.03
        });
      }
    });
  }

  test("theme toggle control is visible and cycles preference", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 960 });
    await resetDemoState(page);
    await applyTheme(page, "dark");

    const toggle = page.getByRole("button", { name: /外观/ });
    await expect(toggle).toBeVisible();
    await toggle.click();
    await expect
      .poll(async () => page.evaluate(() => localStorage.getItem("zhuanfang.color-theme")))
      .toBe("system");
    await toggle.click();
    await expect
      .poll(async () => page.evaluate(() => localStorage.getItem("zhuanfang.color-theme")))
      .toBe("light");
    await expect
      .poll(async () => page.locator("html").getAttribute("data-theme"))
      .toBe("light");
  });
});
