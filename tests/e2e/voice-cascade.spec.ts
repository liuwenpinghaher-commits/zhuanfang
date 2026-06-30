import { test, expect } from "@playwright/test";
import { readFileSync, existsSync } from "node:fs";
import { installFakeMic, speakSession, type VoiceFixture } from "./fakeMic";

// App 级语音访谈模板(办法 B)——「怎么用 fakeMic 驱动真实 cascade 语音访谈」的可运行骨架。
// 默认 skip,满足下面前提并设 E2E_REAL_VOICE=1 后启用:
//   1. 后端用【真 DASHSCOPE key】启动(playwright.config 默认 DASHSCOPE_API_KEY="" 是离线降级,
//      ASR 不会真转写、LLM 不会真追问)。建议:停掉默认 webServer,自己用真 key 起 api+web,再
//      `E2E_REAL_VOICE=1 npx playwright test voice-cascade --project=chromium`。
//   2. 生成对应剧本的 fixture:
//      `node scripts/gen-voice-fixtures.mjs path/to/script.json tests/e2e/fixtures/voice/<name>.json`。
// 机制可行性已由 voice-fakemic-mechanism.spec.ts 真跑证明(合成流→ScriptProcessor 非零 PCM)。
// 下面的 UI 定位(开始专访/录音按钮等)请按实际界面微调。
const FIXTURE = "tests/e2e/fixtures/voice/sample.json";

test.describe("cascade 语音访谈(办法B·需真 key)", () => {
  test.skip(!process.env.E2E_REAL_VOICE, "需真 DASHSCOPE key + 真实语音链路;设 E2E_REAL_VOICE=1 并用真 key 起后端后启用");

  test("语音说一轮 → ASR 转写 → 主持人语音回应 → 写进同一份专访记录", async ({ context }) => {
    test.setTimeout(180_000); // 真实 ASR+LLM 慢,放长超时
    expect(existsSync(FIXTURE), `缺 fixture ${FIXTURE},先跑 gen-voice-fixtures.mjs`).toBeTruthy();
    await installFakeMic(context);
    const page = await context.newPage();
    await page.goto("/");

    // 进访谈台 → 开始一场访谈 → 进语音模式(cascade websocket)
    await page.getByRole("button", { name: "今日访谈台" }).click();
    await page.getByRole("button", { name: /开始专访|开始/ }).first().click();
    await page.getByLabel("开始录音").click();
    await expect(page.locator(".record-button")).toBeVisible({ timeout: 15_000 });

    const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as VoiceFixture;
    await speakSession(page, fixture, async (p) => {
      // 等主持人这一轮回应结束、回到聆听/空闲态,再说下一句(真实链路 thinking→speaking→listening)
      await expect(p.locator(".record-button")).toHaveClass(/listening|idle/, { timeout: 60_000 });
    });

    // 后端断言:这场 session 真有 user+assistant turn(语音回合写进了同一份专访记录)
    const state = await (await page.request.get("http://127.0.0.1:3210/api/state")).json();
    const sess = (state.sessions ?? []).find((s: { status: string }) => s.status === "active")
      ?? (state.sessions ?? []).slice(-1)[0];
    const roles = (sess?.turns ?? []).map((t: { role: string }) => t.role);
    expect(roles, "语音回合应产生用户+主持人 turn").toContain("user");
    expect(roles).toContain("assistant");
  });
});
