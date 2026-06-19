import { expect, test } from "@playwright/test";
import { expectNoHorizontalOverflow, openView, resetDemoState } from "./helpers";

test("creates an AnySearch degraded brief with structured material and can delete it", async ({ page }) => {
  // AnySearch real API can take ~20s per call
  test.setTimeout(90000);
  await resetDemoState(page);
  await openView(page, "外部调研", "主动搜集热点、素材和可讨论主题");

  await page.getByLabel("追踪主题").fill("AI 产品商业化热点");
  // Provider controls were consolidated into a single <select id="search-provider"> + 「生成简报」button.
  // Pick AnySearch explicitly so this test still exercises the AnySearch path, then generate.
  await page.locator("#search-provider").selectOption("anysearch");
  await page.getByRole("button", { name: "生成简报" }).click();

  // AnySearch calls the real API; allow up to 30s. Notice varies: degraded → "搜索已降级完成",
  // success → "搜索简报已生成". Status badge: degraded → "需复核", success → "可用".
  await expect(page.getByText(/搜索已降级完成|搜索简报已生成/)).toBeVisible({ timeout: 30000 });

  // Locate the newly created brief by its topic heading to avoid matching other briefs in demo state
  const newBrief = page.locator("article.record-row").filter({ hasText: "AI 产品商业化热点" });
  await expect(newBrief).toBeVisible({ timeout: 5000 });
  await expect(newBrief.getByText(/anysearch · (可用|需复核)/)).toBeVisible();
  // "Provider：anysearch" lives in the task-status panel (above the brief list), not inside the brief article
  await expect(page.getByText("Provider：anysearch", { exact: true })).toBeVisible();
  // Scoped to the new brief to avoid strict-mode violation from other briefs with same section titles
  // brief-material-grid has aria-label="结构化搜索素材" (div, not a region role) — use locator scoped to newBrief
  await expect(newBrief.locator(".brief-material-grid").getByText("事实", { exact: true })).toBeVisible();
  await expect(newBrief.locator(".brief-material-grid").getByText("争议", { exact: true })).toBeVisible();
  await expect(newBrief.locator(".brief-material-grid").getByText("反方", { exact: true })).toBeVisible();
  await expect(newBrief.locator(".brief-material-grid").getByText("专访角度", { exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);

  // The delete flow has a confirm dialog (possibly two: one in the view, one in App.tsx).
  // Register a persistent handler to accept all dialogs that appear during deletion.
  const dialogHandler = async (dialog: import("@playwright/test").Dialog) => {
    await dialog.accept();
  };
  page.on("dialog", dialogHandler);
  // Scope delete button to the specific brief to avoid strict mode issues from multiple briefs
  await newBrief.getByRole("button", { name: "删除简报" }).click();
  page.off("dialog", dialogHandler);

  await expect(page.getByText("搜索简报已删除")).toBeVisible({ timeout: 10000 });
});

test("sets the default search provider from the search workspace", async ({ page }) => {
  await resetDemoState(page);
  await openView(page, "外部调研", "主动搜集热点、素材和可讨论主题");

  // The per-provider "设为默认：X" chips were replaced by a single 「设为默认」button that commits
  // whatever provider is chosen in #search-provider. The demo default is bailian, so selecting
  // anysearch enables the button (it is disabled when the selection already equals the default).
  await page.locator("#search-provider").selectOption("anysearch");
  await page.getByRole("button", { name: "设为默认" }).click();

  await expect(page.getByText("默认搜索 Provider 已更新")).toBeVisible();
  await expect(page.getByText("当前默认 provider：anysearch").first()).toBeVisible();

  await page.getByRole("button", { name: "系统配置" }).click();
  await page.getByRole("button", { name: /参数/ }).click();
  await expect(page.getByLabel("默认搜索 Provider")).toHaveValue("anysearch");
  await expectNoHorizontalOverflow(page);
});
