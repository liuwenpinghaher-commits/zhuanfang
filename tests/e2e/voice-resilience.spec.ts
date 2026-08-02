import { expect, test, type Page } from "@playwright/test";
import { installFakeMic } from "./fakeMic";
import { resetDemoState } from "./helpers";

const API = "http://127.0.0.1:13210";

async function activeInterview(page: Page) {
  const state = await (await page.request.get(`${API}/api/state`)).json() as {
    sessions?: Array<{ id: string; status: string; turns: Array<{ role: string }> }>;
  };
  const session = state.sessions?.find((item) => item.status === "active");
  if (!session) throw new Error("active interview session not found");
  return session;
}

test("会中 ASR 断开后恢复同一专访，partial 先确认再写入", async ({ context }) => {
  test.setTimeout(60_000);
  await installFakeMic(context);
  await context.addInitScript(() => {
    // 本用例只验证 ASR socket 恢复；生产 VAD 资源由同任务的 smoke:voice-static
    // 针对真实生产静态服务断言，这里走受支持的能量 VAD 降级路径。
    Object.defineProperty(AudioContext.prototype, "audioWorklet", { get: () => undefined });
  });
  const page = await context.newPage();
  let asrConnections = 0;

  await page.routeWebSocket(
    (url) => /\/api\/realtime-voice\/ws\/rtv-/.test(url.pathname) && !url.pathname.includes("/tts/"),
    (ws) => {
      asrConnections += 1;
      ws.onMessage((message) => {
        const parsed = JSON.parse(String(message)) as { type?: string };
        if (parsed.type !== "session.update") return;
        if (asrConnections === 1) {
          ws.send(JSON.stringify({ type: "proxy.connected" }));
          ws.send(JSON.stringify({
            type: "conversation.item.input_audio_transcription.delta",
            text: "断线前的",
            stash: "尾段",
          }));
          void ws.close({ code: 1011, reason: "fault injection" });
        } else {
          setTimeout(() => ws.send(JSON.stringify({ type: "proxy.connected" })), 1_200);
        }
      });
    },
  );

  await page.routeWebSocket((url) => url.pathname.includes("/api/realtime-voice/ws/tts/"), (ws) => {
    ws.onMessage((message) => {
      if ((JSON.parse(String(message)) as { type?: string }).type === "speak") {
        ws.send(JSON.stringify({ type: "tts.done" }));
      }
    });
  });

  await resetDemoState(page);
  await page.getByRole("button", { name: "今日访谈台" }).click();
  await page.getByRole("button", { name: /一键开始|开始专访/ }).click();
  await expect(page.getByLabel("开始录音")).toBeVisible({ timeout: 15_000 });
  const sessionIdBefore = (await activeInterview(page)).id;

  await page.getByLabel("开始录音").click();
  await expect(page.getByText("语音连接恢复中，请稍候")).toBeVisible();
  await expect(page.getByText("等待确认的转写")).toBeVisible();
  expect((await activeInterview(page)).turns.filter((turn) => turn.role === "user")).toHaveLength(0);

  await page.getByLabel("等待确认的语音转写").fill("确认后的完整表达");
  // Vite 开发态覆盖层不属于产品 UI；点击其外部关闭它。Esc 是应用级停止录音快捷键。
  await page.mouse.click(1, 1);
  await expect(page.locator("vite-error-overlay")).toBeHidden();
  await page.getByRole("button", { name: "确认并提交" }).click();
  await expect.poll(
    async () => (await activeInterview(page)).turns.filter((turn) => turn.role === "user").length,
    { timeout: 20_000 },
  ).toBe(1);
  expect((await activeInterview(page)).id).toBe(sessionIdBefore);
  await expect.poll(() => asrConnections).toBe(2);
});
