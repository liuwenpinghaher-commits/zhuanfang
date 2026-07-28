# 语音注入(办法 B):用合成 MediaStream 模拟真麦克风

让 Playwright 能自动化测试 cascade 语音访谈,而不需要真人对着麦克风说话。**完整过真实
`AudioContext → ScriptProcessor → WebSocket → DashScope ASR` 上游链路**,只是把"麦克风采集"
换成由测试按需 push 的、项目自己 TTS 生成的真实语音 PCM;时序由测试掌控(说一轮 → 等主持人
回应 → 说下一轮),避开"假音频文件固定时间轴对不齐多轮交互"的根本缺陷。

## 组成

| 文件 | 作用 |
|---|---|
| `scripts/gen-voice-fixtures.mjs` | 把访谈剧本逐轮用项目 CosyVoice TTS 合成 **16kHz 单声道 s16le PCM**(直接出 16k,无需 resample),句内分段拼 0.3s 静音,输出 base64 JSON fixture |
| `tests/e2e/fakeMic.ts` | `installFakeMic(context)` 注入假 `getUserMedia`(返回 Web Audio `MediaStreamDestination` 流);`speak()` 播一轮 PCM 后等够 VAD 静音窗断句;`speakSession()` 跑整场 |
| `tests/e2e/voice-fakemic-mechanism.spec.ts` | **自包含机制冒烟**(不依赖 App/真 key),证明合成流真能被 ScriptProcessor 读到非零 PCM |
| `tests/e2e/voice-cascade.spec.ts` | App 级语音访谈模板(默认 skip,需真 key 启用) |

## 为什么是 16kHz / 单声道

对齐 `src/realtime/cascadedAsrSource.ts` 实测参数:`getUserMedia({audio:{sampleRate:16000}})` →
`new AudioContext({sampleRate:16000})` → `createScriptProcessor(4096,1,1)`(单声道)。fixture 的
0.3s 句内静音 < `server_vad` 的 `silence_duration_ms:1500`,所以一轮内不会被误切成多个 turn;
轮与轮之间的"长静音断句"由测试时序产生(`speak` 之间没有音频 = 静音 → VAD 超时断句)。

## 用法

```bash
# 1) 生成 fixture(用真 DASHSCOPE key;缺省内置 2 句自检)
node scripts/gen-voice-fixtures.mjs                                  # → tests/e2e/fixtures/voice/sample.json
node scripts/gen-voice-fixtures.mjs script-reason.json tests/e2e/fixtures/voice/reason.json   # 用某剧本

# 2) 机制冒烟(随时可跑,不需真 key/后端)
npx playwright test voice-fakemic-mechanism --project=chromium

# 3) App 级真实语音访谈(需真 key):自己用真 key 起 api+web,然后
E2E_REAL=1 npx playwright test voice-cascade --project=chromium
```

在自己的 spec 里:
```ts
import { installFakeMic, speak, speakSession } from "./fakeMic";
await installFakeMic(context);          // page 创建前
const page = await context.newPage();
// …进入访谈的语音模式(点 aria-label="开始录音")…
await speak(page, fixture.utterances[0].pcmBase64);   // 说一轮,内部已等 1.7s 让 VAD 断句
```

## 已验证(真跑)

- **fixture 生成**:输出 16000/mono/s16le,2 轮 8.4s/6.65s、非零 71%/82%、峰值 ~22000,durationMs 与样本数吻合。
- **注入机制**:机制冒烟 spec 通过——ScriptProcessor 收到 **39 帧、95739 非零样本、峰值 0.671**
  (与 fixture 的 22000/32768≈0.67 一致),证明跨 AudioContext 的合成流路由无损可行。

## 限制 / 注意

- **真 key 才有意义**:`playwright.config.ts` 的 webServer 默认 `DASHSCOPE_API_KEY=""` 是离线降级,
  ASR 不会真转写、LLM 不会真追问。App 级真实语音测试必须用真 key 起后端。
- **慢**:真实 ASR+LLM 每轮数秒、finalize ~90s,超时要相应放长。
- **TTS↔ASR 闭环**:fixture 由项目 TTS 生成,顺带可断言"ASR 转写 ≈ 原文",一条用例测穿两端。
- **ScriptProcessorNode 已 deprecated**(cascadedAsrSource 仍在用,见其第 197 行的告警),办法 B
  随之沿用;若将来迁移到 AudioWorkletNode,fakeMic 的合成流注入方式不变,只是上游节点换掉。
- 轮间 `waitForReply` 的判据(回到 listening/idle)请按真实状态机微调;barge-in(说话打断主持人)
  可在主持人 speaking 态时提前 `speak` 来触发。


## 正确入口

```bash
npm run test:e2e:real
# 或: E2E_REAL=1 npx playwright test voice-cascade
```
语音用例还需要 `DASHSCOPE_API_KEY` 或 `BAILIAN_API_KEY`。
