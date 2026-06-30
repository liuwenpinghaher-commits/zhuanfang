import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { installFakeMic, speak, type VoiceFixture } from "./fakeMic";

// 自包含机制验证(不依赖 App / 真 key / 后端):证明办法 B 的合成麦克风流,真能被 cascadedAsrSource
// 那套「getUserMedia → 独立 AudioContext(16k) → MediaStreamSource → ScriptProcessor(4096,1,1)」
// 读到非零 PCM。跨 AudioContext 路由(fakeMic 的 dest.stream 来自它自己的 context,这里再 new 一个
// 16k context 去 createMediaStreamSource)正是真实链路的形态。过了 → 办法 B 对语音访谈 spec 可用。
test("办法B机制:合成麦克风流能被独立 AudioContext 的 ScriptProcessor 读到非零 PCM", async ({ context }) => {
  await installFakeMic(context);
  const page = await context.newPage();
  await page.setContent("<!doctype html><meta charset=utf-8><title>fakemic</title><body>ready</body>");

  // 复刻 cascadedAsrSource 的音频图,统计 ScriptProcessor 收到的帧数与非零样本数。
  await page.evaluate(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { sampleRate: 16000, channelCount: 1 } });
    const ctx = new AudioContext({ sampleRate: 16000 });
    const srcNode = ctx.createMediaStreamSource(stream);
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    const w = window as unknown as { __frames: number; __nonzero: number; __peak: number };
    w.__frames = 0; w.__nonzero = 0; w.__peak = 0;
    proc.onaudioprocess = (e) => {
      const ch = e.inputBuffer.getChannelData(0);
      w.__frames++;
      for (let i = 0; i < ch.length; i++) { const v = Math.abs(ch[i]); if (v !== 0) w.__nonzero++; if (v > w.__peak) w.__peak = v; }
    };
    srcNode.connect(proc);
    proc.connect(ctx.destination);
    await ctx.resume().catch(() => {});
  });

  const fixture = JSON.parse(readFileSync("tests/e2e/fixtures/voice/sample.json", "utf8")) as VoiceFixture;
  await speak(page, fixture.utterances[0].pcmBase64); // 真实 TTS 生成的 ~8.4s 16k 语音

  const stats = await page.evaluate(() => {
    const w = window as unknown as { __frames: number; __nonzero: number; __peak: number };
    return { frames: w.__frames, nonzero: w.__nonzero, peak: w.__peak };
  });
  console.log("ScriptProcessor 统计:", stats); // 期望 ~32 帧、大量非零、峰值接近 0.x

  expect(stats.frames).toBeGreaterThan(5);       // 8.4s @16k / 4096 ≈ 32 帧
  expect(stats.nonzero).toBeGreaterThan(1000);   // 真实语音流过去了(不是静音)
  expect(stats.peak).toBeGreaterThan(0.05);      // 有正常幅度(Float32 归一后)
});
