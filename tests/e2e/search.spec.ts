import { expect, test } from "@playwright/test";
import { expectNoHorizontalOverflow, openView, resetDemoState } from "./helpers";

test("creates an AnySearch degraded brief with structured material and can delete it", async ({ page }) => {
  await resetDemoState(page);
  await openView(page, "联网素材", "主动搜集热点、素材和可讨论主题");

  await page.getByLabel("追踪主题").fill("AI 产品商业化热点");
  await page.getByRole("button", { name: "AnySearch", exact: true }).click();

  await expect(page.getByText("搜索已降级完成")).toBeVisible();
  await expect(page.getByText("anysearch · 需复核")).toBeVisible();
  await expect(page.getByText("Provider：anysearch", { exact: true })).toBeVisible();
  await expect(page.getByText("事实", { exact: true })).toBeVisible();
  await expect(page.getByText("争议", { exact: true })).toBeVisible();
  await expect(page.getByText("反方", { exact: true })).toBeVisible();
  await expect(page.getByText("专访角度", { exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);

  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("确定要删除这份搜索简报吗");
    await dialog.accept();
  });
  await page.getByRole("button", { name: "删除简报" }).click();

  await expect(page.getByText("搜索简报已删除")).toBeVisible();
});

test("sets the default search provider from the search workspace", async ({ page }) => {
  await resetDemoState(page);
  await openView(page, "联网素材", "主动搜集热点、素材和可讨论主题");

  await page.getByRole("button", { name: "设为默认：AnySearch" }).click();

  await expect(page.getByText("默认搜索 Provider 已更新")).toBeVisible();
  await expect(page.getByText("当前默认 provider：anysearch").first()).toBeVisible();

  await page.getByRole("button", { name: "系统配置" }).click();
  await page.getByRole("button", { name: "策略 搜索、语音和访谈运行策略" }).click();
  await expect(page.getByLabel("默认搜索 Provider")).toHaveValue("anysearch");
  await expectNoHorizontalOverflow(page);
});
