import { expect, test } from "@playwright/test";
import { resetDemoState } from "./helpers";

// Regression guard for the turn-drop bug: submitTurn used to spread the STALE
// closure `session` whenever the API reply carried `interactionPreSignals`
// (which the real character model ALWAYS returns), dropping the freshly-added
// user + assistant turns — the server had them (200) but the UI showed none.
//
// 真实性重构：不再用 page.route 冒充本产品 API（旧 mock 指向 8787 早已打空）。
// 假 character 模型（fake-provider-server.mjs）每轮都附带 <pre_signals> 块，服务端
// 剥离进 interactionPreSignals —— 真实链路天然复现旧 bug 的触发条件（reply 带
// pre_signals），本用例在旧代码上必挂、修复后必过。
test("a submitted text turn renders both turns even when the reply carries pre_signals", async ({ page }) => {
  await resetDemoState(page);

  // P2-16: home start is one-click — "一键开始" creates the session and enters the live interview directly.
  await page.getByRole("button", { name: /一键开始/ }).click();

  const answer = "我在纠结要不要离开大厂去做独立开发，怕失去那种稳定的身份感。";
  await page.getByLabel("你的回答").fill(answer);
  await page.getByRole("button", { name: "提交表达" }).click();

  // BOTH turns must be visible — the old bug dropped them when pre_signals were present.
  // 追问 = fake character 模型模式（你刚才提到「…」+ 具体时刻）；不锁死 12 字切片细节。
  await expect(page.getByText(answer)).toBeVisible({ timeout: 15000 });
  await expect(page.getByText(/你刚才提到「.+」，能给一个具体发生过的时刻吗？/)).toBeVisible({
    timeout: 15000
  });
  // pre_signals 块必须被剥离为结构化字段，绝不作为原文渲染。
  await expect(page.getByText("depth_direction")).toHaveCount(0);
});
