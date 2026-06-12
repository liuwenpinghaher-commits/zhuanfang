import { expect, test } from "@playwright/test";
import { createInitialProductState } from "../../src/domain/engine";
import type { ProductState } from "../../src/domain/types";

test("persists product state changes to the Product API after remote bootstrap", async ({ page }) => {
  let storedState = createInitialProductState();
  const savedStates: ProductState[] = [];

  await page.route("http://127.0.0.1:8787/api/state", async (route) => {
    const request = route.request();

    if (request.method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(storedState)
      });
      return;
    }

    if (request.method() === "PUT") {
      storedState = JSON.parse(request.postData() ?? "{}");
      savedStates.push(storedState);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(storedState)
      });
      return;
    }

    await route.fallback();
  });

  await page.goto("/");
  await expect(page.getByRole("button", { name: "今日访谈台" })).toBeVisible();
  await page.getByRole("button", { name: "个人档案" }).click();
  await page.getByLabel("修正说明").fill("API 同步验证：不要丢失用户修正");
  await page.getByRole("button", { name: "保存修正" }).click();

  await expect
    .poll(() => savedStates.some((state) => state.memoryCorrections.some((correction) => correction.text.includes("API 同步验证"))))
    .toBe(true);
});
