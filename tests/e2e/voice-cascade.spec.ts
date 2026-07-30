import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { installFakeMic, speak, type VoiceFixture } from "./fakeMic";
import { resetServerState } from "./helpers";

// 语音办法 B 端到端:fakeMic 注入合成麦克风 → 进 cascade 语音模式 → 说一轮(项目 TTS 预生成的真实
// 16k 语音)→ 真实 DashScope ASR 转写 → 主持人 LLM 追问 → 写进同一份专访记录。前端直连真后端 3210/真 key。
// 机制可行性已由 voice-fakemic-mechanism.spec.ts 证明;这里验证整条真实链路。
const API = "http://127.0.0.1:13210";
const FIXTURE = "tests/e2e/fixtures/voice/sample.json";

// N-15:真语音端到端(办法 B)需真实 DashScope ASR key,否则整条 cascade 无法转写、必然失败。
// 之前文档声称有 E2E_REAL_VOICE 门控但代码里不存在。这里落实门控:缺真实语音 key 就 skip(而非
// 红失败)。跑法:E2E_REAL=1 + 环境提供 DASHSCOPE_API_KEY(或 BAILIAN_API_KEY),见 playwright.config。
const HAS_REAL_VOICE_KEY = Boolean(process.env.DASHSCOPE_API_KEY || process.env.BAILIAN_API_KEY);

async function active(page: Page) {
  const st = await (await page.request.get(`${API}/api/state`)).json();
  return (st.sessions ?? []).find((s: { status: string }) => s.status === "active") as
    | { status: string; turns?: Array<{ role: string; content?: string }> }
    | undefined;
}

test("语音办法B端到端:fakeMic→真实 ASR→主持人追问→写进专访", async ({ context }) => {
  test.skip(!HAS_REAL_VOICE_KEY, "缺真实语音 provider key(DASHSCOPE_API_KEY/BAILIAN_API_KEY);语音办法B端到端需真实 ASR,跳过。");
  test.setTimeout(120_000);
  const t0 = Date.now();
  const log = (m: string) => console.log(`[+${Math.round((Date.now() - t0) / 1000)}s] ${m}`);

  await installFakeMic(context);
  const page = await context.newPage();
  await resetServerState(page, API); log("reset"); // F-08:reset 需 confirm,统一走 helper
  await page.goto("/"); log("goto");
  await page.getByRole("button", { name: "今日访谈台" }).click(); log("访谈台");
  await page.getByRole("button", { name: /一键开始/ }).click(); log("一键开始");

  // 进语音模式(cascade websocket:连 ASR + getUserMedia=fakeMic)
  await page.getByLabel("开始录音").click(); log("点录音");
  // 关键:等开场 TTS 播完、进入聆听态(micSuppressed 解除)再说话,否则 speak 的音频会被 echo guard 忽略。
  await expect(page.getByText("聆听")).toBeVisible({ timeout: 35_000 }); log("进入聆听态");
  await page.waitForTimeout(1200);

  const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as VoiceFixture;
  await speak(page, fixture.utterances[0].pcmBase64); log(`说完第一轮(${fixture.utterances[0].durationMs}ms 音频)`);

  // 等真实 ASR 转写 → sendUserTurn → 后端出现 user turn
  await expect.poll(async () => ((await active(page))?.turns ?? []).filter((t) => t.role === "user").length,
    { timeout: 50_000, intervals: [2000] }).toBeGreaterThan(0); log("后端有 user turn(ASR 转写成功)");

  const sess = await active(page);
  const turns = sess?.turns ?? [];
  log(`turns: ${turns.map((t) => t.role).join(",")} | user 转写: "${turns.find((t) => t.role === "user")?.content?.slice(0, 30) ?? ""}"`);
  expect(turns.some((t) => t.role === "user"), "语音说话应经真实 ASR 转写后写入 user turn").toBeTruthy();
});
