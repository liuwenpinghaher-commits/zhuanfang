import { expect, test } from "@playwright/test";
import { expectNoHorizontalOverflow, openView, resetDemoState } from "./helpers";

// 真实性重构：本用例不再用 page.route 冒充本产品 API（旧 mock 指向 8787 早已打空）。
// 全流程走真实后端（127.0.0.1:3210），外部网络由 fake-provider-server.mjs 承接：
//   · POST /turns → 假 character 模型回「你刚才提到「…」，能给一个具体发生过的时刻吗？」
//     + <pre_signals> 块（服务端剥离进结构化字段），intent = 百炼角色扮演追问。
//   · POST /end → canned finalize JSON → 双轨笔记档案真实生成。
//   · POST /api/realtime-voice/sessions → 真实路由：默认族 transport=websocket、status=ready，
//     实时语音会话建立后界面切到 WebSocket 实时语音（后续麦克风/上游 WS 失败会如实提示，
//     不影响文本轮次）。
test("runs the interview workflow through the Product API", async ({ page }) => {
  test.setTimeout(90000);
  const apiCalls: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.host === "127.0.0.1:3210" && url.pathname.startsWith("/api/")) {
      apiCalls.push(`${request.method()} ${url.pathname}`);
    }
  });

  await resetDemoState(page);
  await openView(page, "实时专访", "专访启动");
  await page.getByRole("button", { name: "开始专访" }).click();
  await expect(page.getByRole("button", { name: "提交表达" })).toBeVisible();

  // Click the mic toggle (aria-label "开始录音") to trigger the REAL POST
  // /api/realtime-voice/sessions. Assert the session is created (200 · ready · websocket)
  // and the subtitle reflects the transport.
  const voiceSessionResponse = page.waitForResponse(
    (res) => res.url().includes("/api/realtime-voice/sessions") && res.request().method() === "POST"
  );
  await page.getByRole("button", { name: "开始录音" }).click();
  const voiceSession = await voiceSessionResponse;
  expect(voiceSession.status()).toBe(200);
  const voiceSessionBody = (await voiceSession.json()) as { status: string; transport: string };
  expect(voiceSessionBody.status).toBe("ready");
  expect(voiceSessionBody.transport).toBe("websocket");
  await expect(page.getByText("WebSocket 实时语音")).toBeVisible();

  await page.getByLabel("你的回答").fill("我怕放手后项目失控。");
  await page.getByRole("button", { name: "提交表达" }).click();

  // 真实 /turns：fake character 模型的追问文本 + intent 徽标；pre_signals 块被服务端剥离，
  // 绝不作为原文渲染。
  await expect(
    page.getByText("你刚才提到「我怕放手后项目失控。」，能给一个具体发生过的时刻吗？")
  ).toBeVisible({ timeout: 15000 });
  await expect(page.getByText("百炼角色扮演追问").first()).toBeVisible();
  await expect(page.getByText("depth_direction")).toHaveCount(0);

  await page.getByRole("button", { name: "结束并生成档案" }).click();
  await expect(page.getByText("专访档案已生成")).toBeVisible({ timeout: 30000 });
  await expect(page.getByText("从访谈沉淀认知资产")).toBeVisible();
  await expectNoHorizontalOverflow(page);

  expect(apiCalls).toContain("POST /api/interview-sessions");
  expect(apiCalls).toContain("POST /api/realtime-voice/sessions");
  expect(apiCalls.some((call) => call.endsWith("/turns"))).toBe(true);
  expect(apiCalls.some((call) => call.endsWith("/end"))).toBe(true);
});
