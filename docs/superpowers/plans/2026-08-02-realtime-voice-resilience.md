# 实时专访语音韧性 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不重建麦克风音频图、不缓存断线 PCM、不自动提交未 final 文本的前提下，让级联实时语音在会中短暂断线后自动恢复，并把永久失败、兼容模式和 TTS 中断如实呈现给用户。

**Architecture:** 保留 `App → cascadedPipeline → AsrSource/TtsSink` 现有边界；新增纯函数生命周期策略、浏览器 VAD worklet 探测和服务端 WebSocket 韧性模块。ASR 把麦克风生命周期与 socket 生命周期拆开，pipeline 继续作为唯一业务提交入口，服务端代理只负责双向传输、心跳与安全可观测性。

**Tech Stack:** React 18、TypeScript 5、Vitest 4、Fastify 5、`ws` 8、Playwright 1.60、Web Audio API、Docker Compose。

## Global Constraints

- 会中 ASR 自动重连最多 5 次，基准退避依次为 500ms、1s、2s、4s、8s，并增加 0–20% 抖动。
- `start()` 只创建一次 `MediaStream`、`AudioContext`、processor、analyser 和 Silero VAD；socket 重连不得再次调用 `getUserMedia()`。
- `connecting` 或 `reconnecting` 期间丢弃实时 PCM，不缓存、不补发。
- 每个新 socket 都重新发送同一份 `session.update`；只有收到 `proxy.connected` 才进入 `ready` 并发送 PCM。
- provider final 保持现有 turn assembler 语义；断线前仅有的 partial 尾段进入待确认区，确认前不得调用 `sendInterviewTurn()`。
- 手动 `stop()`、本地 code 1000 正常关闭和不可恢复 code 4001 不重连。
- 服务端心跳间隔 15 秒，连续两个周期未收到 pong 才 terminate；任一方向关闭后必须清理全部定时器。
- 日志不得包含逐字稿、PCM、instructions、Authorization、token、cookie 或密钥；reason 必须清洗并截断。
- TTS 中断不得从头重播；文字回合继续保留，下一轮 `speak()` 必须创建新 socket。
- 不改 provider、不修改 vendor、不读取第三方私有字段、不新增依赖、不接触或清空真实数据库。
- 每个任务先运行定向失败测试，再实现，再运行同一测试；未经用户授权不 push。

## 文件结构与职责

| 操作 | 文件 | 单一职责 |
|---|---|---|
| 新增 | `src/realtime/asrConnectionLifecycle.ts` | ASR 状态类型、可恢复关闭码判断、确定性指数退避 |
| 新增 | `src/realtime/asrConnectionLifecycle.test.ts` | 生命周期纯函数边界测试 |
| 修改 | `src/realtime/cascadedAsrSource.ts` | 一次性麦克风图、可替换 socket、会中重连和 recovery partial 发出 |
| 修改 | `src/realtime/cascadedAsrSource.test.ts` | 多 socket、陈旧事件、资源复用和耗尽回归 |
| 修改 | `src/realtime/cascadedPipeline.ts` | recovery review 与现有 echo review 共用唯一确认提交入口 |
| 修改 | `src/realtime/cascadedPipeline.test.ts` | recovery partial 确认前不 POST、确认/丢弃语义 |
| 新增 | `src/realtime/vadWorkletCapability.ts` | fetch、MIME、`addModule()` 三段式能力探测 |
| 新增 | `src/realtime/vadWorkletCapability.test.ts` | worklet 正常、HTML、fetch 失败、执行失败和 context 关闭 |
| 修改 | `src/realtime/sileroVad.ts` | 导出同源 worklet URL 供探测与 MicVAD 共用 |
| 修改 | `src/App.tsx` | 把 ASR 状态、recovery review、VAD degraded 和 TTS 中断接入产品状态 |
| 修改 | `src/features/interview/InterviewView.tsx` | `reconnecting/degraded/exhausted` 可见状态与准确待确认说明 |
| 修改 | `src/features/interview/InterviewView.test.tsx` | 语音韧性状态和 recovery 文案组件测试 |
| 修改 | `src/realtime/cascadedTtsSink.ts` | 意外 close/error 拒绝当前 speak，下一轮惰性重连 |
| 新增 | `src/realtime/cascadedTtsSink.test.ts` | 中断不重播、promise 拒绝、下一轮新 socket |
| 新增 | `apps/api/src/realtime/websocketResilience.ts` | 双周期 ping/pong、reason 清洗和结构化安全日志载荷 |
| 新增 | `apps/api/src/realtime/websocketResilience.test.ts` | 假时钟心跳、清理和敏感信息剔除 |
| 修改 | `apps/api/src/routes/realtime-voice.ts` | 在 ASR/TTS 浏览器 socket 与 DashScope socket 接入韧性模块 |
| 修改 | `apps/api/src/routes/realtime-voice.test.ts` | 上游/浏览器 close code、reason、心跳和安全日志集成回归 |
| 新增 | `tests/e2e/voice-resilience.spec.ts` | Playwright mock WebSocket 故障注入与同一业务 session 恢复 |
| 新增 | `scripts/voice-static-smoke.mjs` | 对生产静态资源 200/MIME/非 HTML/未知 asset 404 做可复用 smoke |
| 修改 | `package.json` | 注册 `smoke:voice-static` 命令 |

---

### Task 1: ASR 生命周期策略与确定性退避

**Files:**
- Create: `src/realtime/asrConnectionLifecycle.ts`
- Create: `src/realtime/asrConnectionLifecycle.test.ts`

**Interfaces:**
- Consumes: WebSocket `CloseEvent.code`、第 1–5 次会中重试序号、可注入 `random(): number`。
- Produces: `AsrConnectionState`、`AsrConnectionEvent`、`isRecoverableAsrCloseCode(code)`、`computeAsrReconnectDelayMs(attempt, baseDelayMs, random)`。

- [x] **Step 1: 写失败测试，锁定状态类型、关闭码和退避边界**

```ts
import { describe, expect, it } from "vitest";
import {
  computeAsrReconnectDelayMs,
  isRecoverableAsrCloseCode,
  type AsrConnectionEvent,
} from "./asrConnectionLifecycle";

describe("ASR 会中重连策略", () => {
  it("500ms 基数形成 500/1000/2000/4000/8000ms", () => {
    expect([1, 2, 3, 4, 5].map((n) => computeAsrReconnectDelayMs(n, 500, () => 0)))
      .toEqual([500, 1000, 2000, 4000, 8000]);
  });

  it("抖动严格落在 0–20%", () => {
    expect(computeAsrReconnectDelayMs(3, 500, () => 1)).toBe(2400);
  });

  it("4001 不可恢复，1006 和临时上游关闭可恢复", () => {
    expect(isRecoverableAsrCloseCode(4001)).toBe(false);
    expect(isRecoverableAsrCloseCode(1006)).toBe(true);
    expect(isRecoverableAsrCloseCode(1011)).toBe(true);
  });

  it("事件类型保留 code/reason 与预算", () => {
    const event: AsrConnectionEvent = {
      state: "reconnecting", attempt: 2, maxAttempts: 5, code: 1006, reason: "network",
    };
    expect(event.state).toBe("reconnecting");
  });
});
```

- [x] **Step 2: 运行测试并确认因模块不存在而失败**

Run: `npm test -- --run src/realtime/asrConnectionLifecycle.test.ts`

Expected: FAIL，错误包含 `Cannot find module './asrConnectionLifecycle'`。

- [x] **Step 3: 实现纯函数与公开类型**

```ts
export type AsrConnectionState =
  | "connecting"
  | "ready"
  | "reconnecting"
  | "exhausted"
  | "stopped";

export interface AsrConnectionEvent {
  state: AsrConnectionState;
  attempt: number;
  maxAttempts: number;
  code?: number;
  reason?: string;
}

const NON_RECOVERABLE_CLOSE_CODES = new Set([4001, 4003]);

export function isRecoverableAsrCloseCode(code: number | undefined): boolean {
  return code == null || !NON_RECOVERABLE_CLOSE_CODES.has(code);
}

export function computeAsrReconnectDelayMs(
  attempt: number,
  baseDelayMs: number,
  random: () => number,
): number {
  const exponent = Math.max(0, attempt - 1);
  const base = Math.max(0, baseDelayMs) * (2 ** exponent);
  const jitter = Math.min(1, Math.max(0, random())) * 0.2;
  return Math.round(base * (1 + jitter));
}
```

- [x] **Step 4: 重跑定向测试**

Run: `npm test -- --run src/realtime/asrConnectionLifecycle.test.ts`

Expected: PASS，4 tests。

- [x] **Step 5: 提交该独立策略单元**

```bash
git add src/realtime/asrConnectionLifecycle.ts src/realtime/asrConnectionLifecycle.test.ts
git commit -m "feat(voice): define ASR reconnect lifecycle policy"
```

### Task 2: 解耦麦克风与 ASR Socket，并实现会中自动恢复

**Files:**
- Modify: `src/realtime/cascadedAsrSource.ts:47-467`
- Modify: `src/realtime/cascadedAsrSource.test.ts:16-776`

**Interfaces:**
- Consumes: Task 1 的 `AsrConnectionEvent`、`computeAsrReconnectDelayMs()`、`isRecoverableAsrCloseCode()`。
- Produces: `CreateBrowserAsrSourceOptions.onConnectionStateChange`、`onRecoveryTranscript`、`maxMidSessionReconnectAttempts`、`midSessionReconnectBaseDelayMs`、`wait`、`random`；保留 `onConnectionLost` 作为耗尽兼容回调。

- [x] **Step 1: 重写测试 harness，使每个 socket 可独立 open/message/error/close**

```ts
interface MockSocketHandle {
  socket: WebSocket;
  sent: string[];
  open(): void;
  message(payload: unknown): void;
  error(): void;
  close(code?: number, reason?: string): void;
}

const sockets: MockSocketHandle[] = [];
const getMicStream = vi.fn(async () => stream);
const wait = vi.fn(async () => undefined);
const random = vi.fn(() => 0);

function createSource(overrides: Partial<CreateBrowserAsrSourceOptions> = {}) {
  const source = createBrowserAsrSource({
    asrWsUrl: "ws://test/asr",
    getMicStream,
    enableSileroVad: false,
    wait,
    random,
    midSessionReconnectBaseDelayMs: 500,
    ...overrides,
  });
  source.register(defaultHandlers());
  return source;
}

async function connectSocket(source: AsrSource, index: number) {
  const started = index === 0 ? source.start() : Promise.resolve();
  await vi.waitFor(() => expect(sockets.length).toBeGreaterThan(index));
  sockets[index].open();
  sockets[index].message({ type: "proxy.connected" });
  await started;
}
```

每个 `close()` 必须构造 `{ code, reason }` 并只触发该实例的 `onclose`，不得复用全局单一回调。

- [x] **Step 2: 写失败测试覆盖会中恢复完整状态机**

```ts
it("ready 后异常关闭会重连且不重建麦克风图", async () => {
  const states = vi.fn();
  const source = createBrowserAsrSource({
    asrWsUrl: "ws://test/asr",
    getMicStream,
    enableSileroVad: false,
    wait,
    random,
    midSessionReconnectBaseDelayMs: 500,
    onConnectionStateChange: states,
  });
  source.register(defaultHandlers());

  const started = source.start();
  sockets[0].open();
  sockets[0].message({ type: "proxy.connected" });
  await started;
  sockets[0].close(1006, "network");
  await vi.waitFor(() => expect(sockets).toHaveLength(2));
  sockets[1].open();
  sockets[1].message({ type: "proxy.connected" });

  await vi.waitFor(() => expect(states).toHaveBeenLastCalledWith(expect.objectContaining({ state: "ready" })));
  expect(getMicStream).toHaveBeenCalledTimes(1);
  expect(audioContextConstructor).toHaveBeenCalledTimes(1);
  expect(wait).toHaveBeenCalledWith(500);
});
```

同一 describe 内再增加以下精确断言：

```ts
expect(sockets[1].sent
  .map((value) => JSON.parse(value))
  .filter((value) => value.type === "session.update"))
  .toHaveLength(1);
expect(onConnectionLost).toHaveBeenCalledTimes(1); // 仅 5 次耗尽后
expect(sockets).toHaveLength(1);                   // stop() 后不重连
expect(states).toHaveBeenLastCalledWith(expect.objectContaining({ state: "exhausted", code: 4001 }));
expect(getMicStream).toHaveBeenCalledTimes(1);     // error + close 成对触发也不重复
```

- [x] **Step 3: 写失败测试锁定 partial 恢复和陈旧 socket 隔离**

```ts
it("断线前仅有的 partial 进入 recovery review，final 不重复", async () => {
  const onRecoveryTranscript = vi.fn();
  const source = createSource({ onRecoveryTranscript });
  await connectSocket(source, 0);
  sockets[0].message({ type: "conversation.item.input_audio_transcription.delta", text: "还没有说", stash: "完" });
  sockets[0].close(1006, "network");
  expect(onRecoveryTranscript).toHaveBeenCalledWith({
    text: "还没有说完", reason: "语音连接中断，尾段尚未由识别服务确认", code: 1006,
  });
});

it("旧 socket 的迟到事件不能污染新 socket", async () => {
  const source = createSource();
  await connectSocket(source, 0);
  sockets[0].close(1006, "network");
  await vi.waitFor(() => expect(sockets).toHaveLength(2));
  sockets[1].open();
  sockets[1].message({ type: "proxy.connected" });
  sockets[0].message({ type: "conversation.item.input_audio_transcription.delta", text: "旧文本", stash: "" });
  sockets[0].close(1006, "late");
  expect(onTranscriptDelta).not.toHaveBeenCalledWith("旧文本", false);
  expect(sockets).toHaveLength(2);
});
```

- [x] **Step 4: 运行新增测试并确认旧实现失败**

Run: `npm test -- --run src/realtime/cascadedAsrSource.test.ts`

Expected: FAIL，至少包含“会中未创建第二个 socket”“`onConnectionStateChange` 未调用”“`getMicStream` 重复或 recovery 回调不存在”。

- [x] **Step 5: 按一次性音频图 + 可替换 socket 实现**

将 `startMic()` 从连接尝试中移出，`start()` 结构固定为：

```ts
async start() {
  if (!handlers) throw new Error("AsrSource: register() must be called before start()");
  if (lifecycle !== "idle") return;
  closed = false;
  emitConnectionState("connecting", 0);
  await startMic();
  try {
    await connectWithInitialRetries();
  } catch (error) {
    stopMic();
    emitConnectionState("exhausted", maxReconnectAttempts);
    throw error;
  }
}
```

`connectSocket()` 必须捕获当前 generation，只允许当前 socket 处理消息：

```ts
const generation = ++socketGeneration;
const socket = new WebSocket(asrWsUrl);
ws = socket;
let ready = false;
let terminationHandled = false;

const isCurrent = () => !closed && ws === socket && generation === socketGeneration;
socket.onopen = () => {
  if (!isCurrent()) return;
  socket.send(JSON.stringify(sessionUpdate));
};
socket.onmessage = (event) => {
  if (!isCurrent()) return;
  if (message.type === "proxy.connected") {
    ready = true;
    latestProviderPartial = "";
    emitConnectionState("ready", 0);
    resolve();
  }
};
const terminate = (event: { code?: number; reason?: string }) => {
  if (terminationHandled || !isCurrent()) return;
  terminationHandled = true;
  handleSocketTermination(socket, event, ready);
};
socket.onerror = () => terminate({ reason: "ASR WebSocket error" });
socket.onclose = (event) => terminate({ code: event.code, reason: event.reason });
```

会中恢复循环必须按以下顺序执行：发 recovery partial → 清空 provider partial → 发 `reconnecting` → wait → 新 socket → 收到 `proxy.connected` 后计数归零。`processor.onaudioprocess` 增加 `lifecycle !== "ready"` 守卫。

- [x] **Step 6: 重跑 ASR 与生命周期测试**

Run: `npm test -- --run src/realtime/asrConnectionLifecycle.test.ts src/realtime/cascadedAsrSource.test.ts`

Expected: PASS；首次连接既有重试、会中 5 次预算、stop、4001、partial、陈旧事件和资源复用全部通过。

- [x] **Step 7: 提交 ASR 核心恢复**

```bash
git add src/realtime/cascadedAsrSource.ts src/realtime/cascadedAsrSource.test.ts
git commit -m "fix(voice): reconnect ASR without rebuilding microphone graph"
```

### Task 3: 将断线 partial 接入权威待确认边界

**Files:**
- Modify: `src/realtime/cascadedPipeline.ts:109-177,217-273,641-747`
- Modify: `src/realtime/cascadedPipeline.test.ts`

**Interfaces:**
- Consumes: `AsrSource` 发出的 `{ text, reason, code? }` recovery item。
- Produces: `TranscriptReviewItem { text; reason; source: "echo" | "recovery" }`、`CascadedPipeline.reviewRecoveryTranscript(item)`；`confirmQuarantinedTranscript()` 与 `discardQuarantinedTranscript()` 保持 UI 调用名不变。

- [x] **Step 1: 写失败测试，证明 recovery 确认前不调用业务 POST**

```ts
it("recovery partial 只进入待确认区，确认后才提交", async () => {
  const onTranscriptQuarantined = vi.fn();
  const base = makeOpts();
  const pipeline = connectCascadedPipeline({
    ...base,
    callbacks: { ...base.callbacks, onTranscriptQuarantined },
  });

  asr.pushDelta("前半段", true);
  pipeline.reviewRecoveryTranscript({ text: "未确认尾段", reason: "连接中断", code: 1006 });
  expect(onTranscriptQuarantined).toHaveBeenCalledWith({
    text: "未确认尾段", reason: "连接中断", source: "recovery",
  });
  expect(sendUserTurn.fn).not.toHaveBeenCalled();

  pipeline.confirmQuarantinedTranscript("修改后的尾段");
  await vi.waitFor(() => expect(sendUserTurn.fn).toHaveBeenCalledWith("前半段修改后的尾段", expect.any(AbortSignal)));
});
```

- [x] **Step 2: 写失败测试，证明丢弃只丢 recovery 尾段**

```ts
it("丢弃 recovery partial 后保留已 final 的当前表达", () => {
  const pipeline = connectCascadedPipeline(makeOpts());
  asr.pushDelta("已确认前半段", true);
  pipeline.reviewRecoveryTranscript({ text: "不要的尾段", reason: "连接中断", code: 1006 });
  pipeline.discardQuarantinedTranscript();
  expect(userTranscripts).toContainEqual({ text: "已确认前半段", isFinal: false });
  expect(sendUserTurn.fn).not.toHaveBeenCalled();
});
```

- [x] **Step 3: 运行定向测试并确认公开方法不存在**

Run: `npm test -- --run src/realtime/cascadedPipeline.test.ts`

Expected: FAIL，TypeScript/Vitest 报 `reviewRecoveryTranscript is not a function`。

- [x] **Step 4: 实现两类 review 的分支确认语义**

```ts
export interface TranscriptReviewItem {
  text: string;
  reason: string;
  source: "echo" | "recovery";
}

let activeReview: TranscriptReviewItem | null = null;

function surfaceQuarantine(item: TranscriptReviewItem) {
  activeReview = item;
  callbacks.onTranscriptQuarantined?.(item);
}
```

`reviewRecoveryTranscript()` 清空 `partialTranscript`，但保留 `committedTranscript`。确认 recovery 时把“已 final 前半段 + 用户编辑尾段”重新作为 final ingest 到 `turnAssembler` 后调用 `requestStableCommit(true)`；丢弃 recovery 时保留 committed，并把实时文本回显为 committed。echo 分支保持原 `turnAssembler.confirmQuarantined()` 和 `resetTurn()` 行为。

- [x] **Step 5: 重跑 pipeline 测试**

Run: `npm test -- --run src/realtime/cascadedPipeline.test.ts`

Expected: PASS，且现有 echo quarantine 用例不回归。

- [x] **Step 6: 提交权威确认边界**

```bash
git add src/realtime/cascadedPipeline.ts src/realtime/cascadedPipeline.test.ts
git commit -m "fix(voice): quarantine interrupted partial transcripts"
```

### Task 4: AudioWorklet 能力探测与语音恢复 UI

**Files:**
- Create: `src/realtime/vadWorkletCapability.ts`
- Create: `src/realtime/vadWorkletCapability.test.ts`
- Modify: `src/realtime/sileroVad.ts:23-34`
- Modify: `src/App.tsx:240-264,1453-1483,2644-2795,3223-3262`
- Modify: `src/features/interview/InterviewView.tsx:10-44,228-308`
- Modify: `src/features/interview/InterviewView.test.tsx`

**Interfaces:**
- Consumes: `resolveVadWorkletUrl()`、浏览器 `fetch`、临时 `AudioContext.audioWorklet.addModule()`、Task 2 状态回调、Task 3 review 方法。
- Produces: `probeVadWorkletCapability(): Promise<{ supported: boolean; reason?: "fetch" | "mime" | "execution" | "unsupported" }>`；共享 `VoiceUiStatus`。

- [x] **Step 1: 写 VAD probe 失败测试**

```ts
it("HTML fallback 被判定为 degraded 且始终关闭探测 context", async () => {
  const close = vi.fn(async () => undefined);
  const addModule = vi.fn(async () => undefined);
  const result = await probeVadWorkletCapability({
    fetchImpl: vi.fn(async () => new Response("<!doctype html>", { headers: { "content-type": "text/html" } })),
    createAudioContext: () => ({ audioWorklet: { addModule }, close }) as unknown as AudioContext,
  });
  expect(result).toEqual({ supported: false, reason: "mime" });
  expect(addModule).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledOnce();
});
```

同一文件加入以下四个确定性用例：

```ts
function makeDeps(overrides: {
  response?: Response;
  audioWorklet?: AudioWorklet;
  withoutAudioWorklet?: boolean;
  addModuleError?: Error;
} = {}) {
  const addModule = vi.fn(async () => {
    if (overrides.addModuleError) throw overrides.addModuleError;
  });
  return {
    fetchImpl: vi.fn(async () => overrides.response ?? new Response("worklet", {
      status: 200, headers: { "content-type": "text/javascript" },
    })),
    createAudioContext: () => ({
      audioWorklet: overrides.withoutAudioWorklet
        ? undefined
        : (overrides.audioWorklet ?? { addModule }),
      close: vi.fn(async () => undefined),
    }) as unknown as AudioContext,
  };
}

it("JavaScript MIME 且 addModule 成功时返回 supported", async () => {
  const result = await probeVadWorkletCapability(makeDeps({
    response: new Response("registerProcessor('vad', class {})", {
      status: 200, headers: { "content-type": "text/javascript" },
    }),
  }));
  expect(result).toEqual({ supported: true });
});

it("非 2xx 返回 fetch 原因", async () => {
  const result = await probeVadWorkletCapability(makeDeps({ response: new Response("missing", { status: 404 }) }));
  expect(result).toEqual({ supported: false, reason: "fetch" });
});

it("没有 audioWorklet 返回 unsupported", async () => {
  const result = await probeVadWorkletCapability(makeDeps({ withoutAudioWorklet: true }));
  expect(result).toEqual({ supported: false, reason: "unsupported" });
});

it("addModule AbortError 返回 execution", async () => {
  const result = await probeVadWorkletCapability(makeDeps({
    addModuleError: new DOMException("Unable to load", "AbortError"),
  }));
  expect(result).toEqual({ supported: false, reason: "execution" });
});
```

- [x] **Step 2: 运行 probe 测试并确认模块不存在**

Run: `npm test -- --run src/realtime/vadWorkletCapability.test.ts`

Expected: FAIL，模块不存在。

- [x] **Step 3: 实现公开 URL 与三段式探测**

```ts
export function resolveVadWorkletUrl(): string {
  return `${resolveVadAssetRoot()}vad.worklet.bundle.min.js`;
}

export async function probeVadWorkletCapability(deps = browserDefaults): Promise<VadWorkletCapability> {
  const context = deps.createAudioContext();
  try {
    if (!context.audioWorklet) return { supported: false, reason: "unsupported" };
    const response = await deps.fetchImpl(resolveVadWorkletUrl(), { cache: "no-store" });
    if (!response.ok) return { supported: false, reason: "fetch" };
    const mime = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!mime.includes("javascript")) return { supported: false, reason: "mime" };
    await context.audioWorklet.addModule(resolveVadWorkletUrl());
    return { supported: true };
  } catch {
    return { supported: false, reason: "execution" };
  } finally {
    await context.close().catch(() => undefined);
  }
}
```

- [x] **Step 4: 写 UI 失败测试覆盖三种新状态和 recovery 说明**

```ts
for (const [status, copy] of [
  ["reconnecting", "语音连接恢复中，请稍候"],
  ["degraded", "语音兼容模式"],
  ["exhausted", "语音连接未恢复，已保留本场文字专访"],
] as const) {
  it(`显示 ${status}`, () => {
    const session = createSessionDraft(createInitialProductState(), "organization");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root?.render(<InterviewView
      card={session.card} session={session} pendingMode="organization" input=""
      recording={status !== "exhausted"} realtimeState={null} audioLevel={0}
      voiceStatus={status} liveUserTranscript="" voiceTransport="websocket"
      onInput={vi.fn()} onStart={vi.fn()} onSubmit={vi.fn()} onFinish={vi.fn()}
      onControl={vi.fn()} onToggleRecording={vi.fn()} onInterrupt={vi.fn()} />));
    expect(container.textContent).toContain(copy);
  });
}

it("recovery review 不再声称一定混入 AI 语音", () => {
  const session = createSessionDraft(createInitialProductState(), "organization");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<InterviewView
    card={session.card} session={session} pendingMode="organization" input="" recording
    realtimeState={null} audioLevel={0} voiceStatus="reconnecting" liveUserTranscript=""
    voiceTransport="websocket"
    voiceReviewItem={{ text: "未完成尾段", reason: "连接中断", source: "recovery" }}
    onInput={vi.fn()} onStart={vi.fn()} onSubmit={vi.fn()} onFinish={vi.fn()}
    onControl={vi.fn()} onToggleRecording={vi.fn()} onInterrupt={vi.fn()} />));
  expect(container.textContent).toContain("连接中断前的尾段尚未确认");
  expect(container.textContent).toContain("尚未写入专访");
});
```

- [x] **Step 5: 运行组件测试并确认状态联合类型与文案失败**

Run: `npm test -- --run src/features/interview/InterviewView.test.tsx`

Expected: FAIL，`VoiceUiStatus` 不含新状态且新文案不可见。

- [x] **Step 6: 接入 App 状态与恢复回调**

新增共享类型：

```ts
export type VoiceUiStatus =
  | "idle" | "connecting" | "listening" | "speaking" | "interrupted"
  | "reconnecting" | "degraded" | "exhausted";
```

`toggleRealtimeRecording()` 在创建 ASR 前探测 worklet；失败只设置 degraded 提示，不阻止 MicVAD 自身 fallback。ASR 回调接线固定为：

```ts
onConnectionStateChange: (event) => {
  if (event.state === "reconnecting") setVoiceStatus("reconnecting");
  if (event.state === "ready") setVoiceStatus(vadCapability.supported ? "listening" : "degraded");
  if (event.state === "exhausted") {
    setRecording(false);
    setVoiceStatus("exhausted");
    ttsSinkRef.current?.close?.();
    ttsSinkRef.current = null;
  }
},
onRecoveryTranscript: (item) => cascadePipelineRef.current?.reviewRecoveryTranscript(item),
onConnectionLost: (error) => {
  setNotice(buildNotice("warning", "语音连接未恢复", `${error.message}。本场文字专访仍可继续。`));
},
```

重新点击“语音”且旧状态为 `exhausted` 时，先调用 `closeRealtimeVoiceSession()` 清理旧 pipeline，再创建新 realtime session。

- [x] **Step 7: 重跑 probe、pipeline、App 相关和 InterviewView 测试**

Run: `npm test -- --run src/realtime/vadWorkletCapability.test.ts src/realtime/cascadedPipeline.test.ts src/features/interview/InterviewView.test.tsx`

Expected: PASS，三个文件全部通过。

- [x] **Step 8: 提交探测与产品可见状态**

```bash
git add src/realtime/vadWorkletCapability.ts src/realtime/vadWorkletCapability.test.ts src/realtime/sileroVad.ts src/App.tsx src/features/interview/InterviewView.tsx src/features/interview/InterviewView.test.tsx
git commit -m "feat(voice): surface reconnect and worklet compatibility states"
```

### Task 5: TTS 中断可见化与下一轮惰性恢复

**Files:**
- Modify: `src/realtime/cascadedTtsSink.ts:34-299`
- Create: `src/realtime/cascadedTtsSink.test.ts`
- Modify: `src/realtime/cascadedPipeline.ts:109-123,384-638,688-747`
- Modify: `src/realtime/cascadedPipeline.test.ts`
- Modify: `src/App.tsx:2725-2757`

**Interfaces:**
- Consumes: 浏览器 TTS socket 的 `error/close`、pipeline `callbacks`。
- Produces: `TtsPlaybackInterruptedError`、`CascadedPipelineCallbacks.onTtsPlaybackInterrupted`；下一次 `speak()` 新建 socket。

- [x] **Step 1: 写 TTS sink 失败测试**

```ts
interface MockTtsSocket {
  sent: string[];
  open(): void;
  message(data: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
}

const sockets: MockTtsSocket[] = [];

it("中途 close 拒绝当前 speak，下一轮创建新 socket且不重发旧 segments", async () => {
  const sink = createBrowserTtsSink("ws://test/tts", "voice");
  const first = sink.speak(["第一轮"]);
  sockets[0].open();
  sockets[0].close(1011, "upstream interrupted");
  await expect(first).rejects.toMatchObject({ name: "TtsPlaybackInterruptedError" });

  const second = sink.speak(["第二轮"]);
  expect(sockets).toHaveLength(2);
  sockets[1].open();
  sockets[1].message(JSON.stringify({ type: "tts.done" }));
  await second;
  expect(sockets[1].sent
    .map((value) => JSON.parse(value))
    .filter((value) => value.type === "speak")
    .map((value) => value.segments))
    .toEqual([["第二轮"]]);
});
```

同一文件加入主动停止与终态关闭用例：

```ts
it("主动 stop 正常 resolve 当前 speak", async () => {
  const sink = createBrowserTtsSink("ws://test/tts");
  const speaking = sink.speak(["会被主动停止"]);
  sockets[0].open();
  sink.stop();
  await expect(speaking).resolves.toBeUndefined();
});

it("close 幂等且不会重播 active segments", async () => {
  const sink = createBrowserTtsSink("ws://test/tts");
  const speaking = sink.speak(["只发送一次"]);
  sockets[0].open();
  sink.close?.();
  sink.close?.();
  await expect(speaking).resolves.toBeUndefined();
  expect(sockets).toHaveLength(1);
  expect(sockets[0].sent.filter((value) => JSON.parse(value).type === "speak")).toHaveLength(1);
});
```

- [x] **Step 2: 运行 sink 测试并确认旧实现错误地 resolve**

Run: `npm test -- --run src/realtime/cascadedTtsSink.test.ts`

Expected: FAIL，当前 `onclose` 调用 resolve 而非 reject。

- [x] **Step 3: 实现带 socket 身份的 active speak settle**

```ts
export class TtsPlaybackInterruptedError extends Error {
  readonly code?: number;
  constructor(message: string, code?: number) {
    super(message);
    this.name = "TtsPlaybackInterruptedError";
    this.code = code;
  }
}

let activeSpeak: {
  socket: WebSocket;
  resolve: () => void;
  reject: (error: Error) => void;
  cleanup: () => void;
} | null = null;
```

只有 `!stopped && activeSpeak?.socket === socket` 的意外 `error/close` 才 reject；`stop()` 与 terminal `close()` 先设置 `stopped = true` 再 resolve。socket 关闭后仅置 `ws = null`，不重发任何 segments。

- [x] **Step 4: 写 pipeline 失败测试，确保 TTS 中断不关闭 ASR**

```ts
it("TTS 中断保留文字、回到 listening 且不关闭 ASR", async () => {
  const onTtsPlaybackInterrupted = vi.fn();
  const base = makeOpts();
  const interruptedTts = {
    ...tts,
    speak: vi.fn().mockRejectedValueOnce(new TtsPlaybackInterruptedError("播放中断", 1011)),
  };
  const asrStop = vi.spyOn(asr, "stop");
  const pipeline = connectCascadedPipeline({
    ...base,
    tts: interruptedTts,
    callbacks: { ...base.callbacks, onTtsPlaybackInterrupted },
  });
  await pipeline.startListening();
  asr.pushDelta("完整用户表达", true);
  asr.pushSpeechStopped(900);
  await vi.waitFor(() => expect(interruptedTts.speak).toHaveBeenCalled());
  expect(assistantTexts).toContain(FIXED_ASSISTANT_TEXT);
  expect(onTtsPlaybackInterrupted).toHaveBeenCalledOnce();
  expect(stateChanges.at(-1)).toBe("listening");
  expect(asrStop).not.toHaveBeenCalled();
});
```

- [x] **Step 5: pipeline 统一报告非主动 TTS 失败**

为 opening、backchannel、stream flush、filler 和整段播放的 catch 统一调用 `handleTtsFailure(error)`；主动 `tts.stop()` 仍 resolve，不进入该回调。App 的回调显示“本轮语音播放中断，文字内容已保留”。

- [x] **Step 6: 重跑 sink 与 pipeline 测试**

Run: `npm test -- --run src/realtime/cascadedTtsSink.test.ts src/realtime/cascadedPipeline.test.ts`

Expected: PASS；下一轮新 socket、无自动重播、ASR 未关闭。

- [x] **Step 7: 提交 TTS 韧性**

```bash
git add src/realtime/cascadedTtsSink.ts src/realtime/cascadedTtsSink.test.ts src/realtime/cascadedPipeline.ts src/realtime/cascadedPipeline.test.ts src/App.tsx
git commit -m "fix(voice): recover cleanly from interrupted TTS playback"
```

### Task 6: 服务端双向心跳、关闭原因和安全日志

**Files:**
- Create: `apps/api/src/realtime/websocketResilience.ts`
- Create: `apps/api/src/realtime/websocketResilience.test.ts`
- Modify: `apps/api/src/routes/realtime-voice.ts:54-74,610-860,1024-1038`
- Modify: `apps/api/src/routes/realtime-voice.test.ts`

**Interfaces:**
- Consumes: `ws` 的 `ping`、`pong`、`terminate`、`close`、`error`；可注入 interval 函数和 `now()`。
- Produces: `attachWebSocketHeartbeat()` 返回幂等 `dispose()`；`buildRealtimeProxyLog()` 返回固定字段安全载荷。

- [x] **Step 1: 写纯模块失败测试**

```ts
it("连续两个周期无 pong 才 terminate，收到 pong 会归零", () => {
  vi.useFakeTimers();
  const socket = createFakeHeartbeatSocket();
  const onTimeout = vi.fn();
  const dispose = attachWebSocketHeartbeat(socket, { intervalMs: 15_000, maxMissedPongs: 2, onTimeout });

  vi.advanceTimersByTime(15_000);
  expect(socket.terminate).not.toHaveBeenCalled();
  socket.emit("pong");
  vi.advanceTimersByTime(15_000);
  expect(socket.terminate).not.toHaveBeenCalled();
  vi.advanceTimersByTime(15_000);
  expect(socket.terminate).toHaveBeenCalledOnce();
  expect(onTimeout).toHaveBeenCalledOnce();
  dispose();
});

it("安全日志清除 bearer、换行和过长 reason", () => {
  const payload = buildRealtimeProxyLog({
    event: "realtime_proxy_upstream_closed",
    sessionId: "rtv-1",
    direction: "upstream",
    code: 1011,
    reason: "Bearer secret-value\ntranscript=用户原话",
    phase: "ready",
    durationMs: 1234,
  });
  expect(JSON.stringify(payload)).not.toContain("secret-value");
  expect(JSON.stringify(payload)).not.toContain("用户原话");
  expect(payload).toEqual(expect.objectContaining({ code: 1011, phase: "ready", durationMs: 1234 }));
});
```

- [x] **Step 2: 运行测试并确认模块不存在**

Run: `npm test -- --run apps/api/src/realtime/websocketResilience.test.ts`

Expected: FAIL，模块不存在。

- [x] **Step 3: 实现心跳与固定 schema 日志**

```ts
export function attachWebSocketHeartbeat(socket: HeartbeatSocket, options: HeartbeatOptions): () => void {
  let missed = 0;
  let disposed = false;
  const onPong = () => { missed = 0; };
  socket.on("pong", onPong);
  const timer = setInterval(() => {
    if (disposed || socket.readyState !== WebSocket.OPEN) return;
    missed += 1;
    if (missed >= options.maxMissedPongs) {
      options.onTimeout();
      socket.terminate();
      return;
    }
    socket.ping();
  }, options.intervalMs);
  return () => {
    if (disposed) return;
    disposed = true;
    clearInterval(timer);
    socket.off("pong", onPong);
  };
}
```

`buildRealtimeProxyLog()` 只返回 `event/sessionId/direction/code/reason/phase/durationMs`；reason 删除 CR/LF，替换 `Bearer ...`、`token=...`、`transcript=...`，最后按 UTF-8 截到 160 字节。

- [x] **Step 4: 写路由集成失败测试**

新增可测试注入项：

```ts
createRealtimeUpstream?: (url: string, options: { headers: Record<string, string> }) => WebSocket;
heartbeatIntervalMs?: number;
heartbeatMaxMissedPongs?: number;
now?: () => number;
```

集成测试建立真实浏览器侧 `WsClient` 与假的 upstream，断言：

```ts
expect(browserClose).toEqual({ code: 1011, reason: "temporary upstream close" });
expect(logs).toContainEqual(expect.objectContaining({
  event: "realtime_proxy_upstream_closed", sessionId, direction: "upstream", code: 1011,
}));
expect(JSON.stringify(logs)).not.toMatch(/Authorization|Bearer|transcript|input_audio_buffer/);
expect(upstream.listenerCount("pong")).toBe(0);
expect(upstream.listenerCount("close")).toBe(0);
```

- [x] **Step 5: 在 ASR 和 TTS proxy 接入心跳及结构化日志**

浏览器 socket 与 DashScope socket 分别持有 disposer；任一侧 `close/error` 都执行同一个幂等 `cleanup()`。阶段只取 `connecting | ready | closing`。上游 close 先安全日志，再把合法 code/reason 透传浏览器；浏览器 close 记录后以 1000 关闭上游。心跳超时记录 `realtime_proxy_heartbeat_timeout` 后 terminate 对应死连接。

关闭码钳制允许 `1000–1014` 中除 `1004/1005/1006` 外的标准可发送码，以及 `3000–4999` 应用码；`1015` 和其他值回落到 `1000`。因此上游临时故障 `1011` 必须原样到达浏览器。

- [x] **Step 6: 重跑纯模块和路由测试**

Run: `npm test -- --run apps/api/src/realtime/websocketResilience.test.ts apps/api/src/routes/realtime-voice.test.ts`

Expected: PASS；测试结束无 open handle 警告，无明文敏感内容。

- [x] **Step 7: 提交服务端韧性**

```bash
git add apps/api/src/realtime/websocketResilience.ts apps/api/src/realtime/websocketResilience.test.ts apps/api/src/routes/realtime-voice.ts apps/api/src/routes/realtime-voice.test.ts
git commit -m "fix(api): add realtime proxy heartbeats and safe close telemetry"
```

### Task 7: 浏览器故障注入与生产静态资源 smoke

**Files:**
- Create: `tests/e2e/voice-resilience.spec.ts`
- Create: `scripts/voice-static-smoke.mjs`
- Modify: `package.json:6-20`

**Interfaces:**
- Consumes: Playwright `page.routeWebSocket()`、fake mic、生产同源 URL。
- Produces: 默认隔离 E2E 的会中重连证据；`npm run smoke:voice-static -- <base-url>`。

- [x] **Step 1: 写 Playwright 故障注入测试**

```ts
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
  await installFakeMic(context);
  const page = await context.newPage();
  let asrConnections = 0;

  await page.routeWebSocket((url) => /\/api\/realtime-voice\/ws\/rtv-/.test(url.pathname) && !url.pathname.includes("/tts/"), (ws) => {
    asrConnections += 1;
    ws.onMessage((message) => {
      const parsed = JSON.parse(String(message));
      if (parsed.type !== "session.update") return;
      if (asrConnections === 1) {
        ws.send(JSON.stringify({ type: "proxy.connected" }));
        ws.send(JSON.stringify({
          type: "conversation.item.input_audio_transcription.delta", text: "断线前的", stash: "尾段",
        }));
        void ws.close({ code: 1011, reason: "fault injection" });
      } else {
        setTimeout(() => ws.send(JSON.stringify({ type: "proxy.connected" })), 1200);
      }
    });
  });

  await page.routeWebSocket((url) => url.pathname.includes("/api/realtime-voice/ws/tts/"), (ws) => {
    ws.onMessage((message) => {
      if (JSON.parse(String(message)).type === "speak") ws.send(JSON.stringify({ type: "tts.done" }));
    });
  });

  await resetDemoState(page);
  await page.getByRole("button", { name: "今日访谈台" }).click();
  await page.getByRole("button", { name: /一键开始|开始专访/ }).click();
  const sessionIdBefore = (await activeInterview(page)).id;
  await page.getByLabel("开始录音").click();
  await expect(page.getByText("语音连接恢复中，请稍候")).toBeVisible();
  await expect(page.getByText("等待确认的转写")).toBeVisible();
  expect((await activeInterview(page)).turns.filter((turn) => turn.role === "user")).toHaveLength(0);
  await page.getByLabel("等待确认的语音转写").fill("确认后的完整表达");
  await page.getByRole("button", { name: "确认并提交" }).click();
  await expect.poll(async () => (await activeInterview(page)).turns.filter((turn) => turn.role === "user").length).toBe(1);
  expect((await activeInterview(page)).id).toBe(sessionIdBefore);
  expect(asrConnections).toBe(2);
});
```

helper 只复用 `tests/e2e/helpers.ts` 现有隔离 API；不得调用 reset/purge 真实数据端点，测试档位由 `global-setup.ts` 强制为 memory。

- [x] **Step 2: 运行 E2E 并确认当前 UI 不会重连**

Run: `npx playwright test tests/e2e/voice-resilience.spec.ts --project=chromium`

Expected: 修复前 FAIL，`asrConnections` 仍为 1，页面转为“语音连接已断开”或录音被关闭。

- [x] **Step 3: 实现生产静态资源 smoke 脚本**

```js
const baseUrl = new URL(process.argv[2] ?? "http://127.0.0.1:3210");

async function assertAsset(path, expectedMime) {
  const response = await fetch(new URL(path, baseUrl));
  const body = await response.text();
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  if (!response.headers.get("content-type")?.toLowerCase().includes(expectedMime)) {
    throw new Error(`${path}: unexpected content-type ${response.headers.get("content-type")}`);
  }
  if (/<!doctype html|<html/i.test(body)) throw new Error(`${path}: received HTML fallback`);
}

await assertAsset("/vad/vad.worklet.bundle.min.js", "javascript");
await assertAsset("/vad/silero_vad_v5.onnx", "application");
const missing = await fetch(new URL("/vad/definitely-missing.worklet.js", baseUrl));
if (missing.status !== 404 || /text\/html/i.test(missing.headers.get("content-type") ?? "")) {
  throw new Error("missing VAD asset must be plain-text 404");
}
console.log(JSON.stringify({ event: "voice_static_smoke_pass", baseUrl: baseUrl.toString() }));
```

在 `package.json` scripts 增加：

```json
"smoke:voice-static": "node scripts/voice-static-smoke.mjs"
```

- [x] **Step 4: 重跑 E2E 与本地生产静态 smoke**

Run: `npx playwright test tests/e2e/voice-resilience.spec.ts --project=chromium`

Expected: PASS；两次 ASR socket、同一 interview session、确认前 0 user turn、确认后恰好 1 user turn。

Run: `npm run build && PRODUCT_STATIC_DIR=dist PORT=13240 HOST=127.0.0.1 npm run start:api`

在另一个终端运行：`npm run smoke:voice-static -- http://127.0.0.1:13240`

Expected: 输出 `voice_static_smoke_pass`；worklet 200 + JavaScript MIME，未知 worklet 404 + 非 HTML。

- [x] **Step 5: 提交故障注入与 smoke**

```bash
git add tests/e2e/voice-resilience.spec.ts scripts/voice-static-smoke.mjs package.json
git commit -m "test(voice): cover reconnect and production worklet assets"
```

### Task 8: 全量门禁、Docker 真实运行态和代码审查

**Files:**
- Verify: all files changed by Tasks 1–7
- Update: `docs/superpowers/plans/2026-08-02-realtime-voice-resilience.md` checkbox state only after each command has real evidence

**Interfaces:**
- Consumes: 所有前述任务的测试和生产构建产物。
- Produces: 可审查 diff、全量验证证据、真实容器静态资源证据和明确未完成项。

- [x] **Step 1: 运行类型检查和全部语音定向测试**

Run: `npm run typecheck`

Expected: exit 0。

Run: `npm test -- --run src/realtime/asrConnectionLifecycle.test.ts src/realtime/cascadedAsrSource.test.ts src/realtime/cascadedPipeline.test.ts src/realtime/vadWorkletCapability.test.ts src/realtime/cascadedTtsSink.test.ts src/features/interview/InterviewView.test.tsx apps/api/src/realtime/websocketResilience.test.ts apps/api/src/routes/realtime-voice.test.ts`

Expected: exit 0，无 skipped 新用例。

- [x] **Step 2: 运行全量单元/API 测试**

Run: `REAL_PROVIDER_SMOKE=off npm test -- --run`

Expected: exit 0；任何与本次改动相关失败必须修根因并重跑，不得删除测试或放宽断言。

- [x] **Step 3: 运行生产 build 和默认隔离 Playwright**

Run: `npm run build`

Expected: exit 0，`dist/vad/vad.worklet.bundle.min.js` 存在。

Run: `npx playwright test tests/e2e/voice-resilience.spec.ts --project=chromium`

Expected: exit 0，隔离档位为 memory。

- [x] **Step 4: 重建 Docker，但绝不删除数据卷**

Run: `env -u DEPLOYMENT_PROFILE -u PRODUCT_STATIC_DIR -u PRODUCT_ENV_FILE docker compose --env-file .env.production.local up -d --build --force-recreate`

Expected: compose exit 0；禁止运行 `docker compose down -v`。

Run: `docker compose --env-file .env.production.local ps`

Expected: 应用容器 healthy，端口 `3210` 可访问。

Run: `npm run smoke:voice-static -- http://127.0.0.1:3210`

Expected: `voice_static_smoke_pass`。

- [x] **Step 5: 在真实浏览器检查状态与控制台**

打开 `http://127.0.0.1:3210`，开始一场隔离的测试专访并点击语音。验证：

```text
1. /vad/vad.worklet.bundle.min.js 为 200 + JavaScript MIME。
2. 控制台不再出现 Unable to load a worklet's module。
3. 正常路径不显示“语音兼容模式”。
4. 故障注入时依次可见 reconnecting → listening/degraded；专访 session ID 不变。
5. recovery 尾段确认前无 user turn，确认后恰好写入一次。
6. exhausted 后文字输入仍可提交；重新点语音建立全新 voice transport。
```

真实 provider/麦克风门禁需要当前浏览器麦克风权限；若权限被系统阻止，只能将该条标为 `partial`，不得用单元测试冒充真人验证。

- [x] **Step 6: 审查 diff 的架构和敏感信息边界**

Run: `git diff --check && git diff --stat && git status --short`

Expected: 无 whitespace error；业务改动只涉及文件结构表中列出的路径。

Run: `rg -n "TO[D]O|TB[D]|NotImplemented|Authorization|Bearer|input_audio_buffer.append|instructions" src/realtime apps/api/src/realtime apps/api/src/routes/realtime-voice.ts tests/e2e/voice-resilience.spec.ts`

Expected: 没有新占位实现；`Authorization` 只存在于现有上游连接头，不进入新日志；逐字稿和 PCM 不进入日志载荷。

- [x] **Step 7: 进行独立代码审查并修正 P0/P1**

审查必须逐项给出证据：

```text
ASR-1 麦克风/AudioContext 只创建一次
ASR-2 会中 5 次指数退避并可停止
ASR-3 陈旧 socket 事件隔离
DATA-1 partial 确认前零权威写入
DATA-2 确认/丢弃不重复或吞掉已 final 文本
UI-1 reconnecting/degraded/exhausted 均可见且文字可继续
API-1 双周期心跳和定时器清理
API-2 日志无逐字稿、音频和密钥
TTS-1 中断不重播，下一轮新 socket
OPS-1 worklet 生产资源与 404 契约成立
```

发现 P0/P1 后新增对应失败测试、修复、重跑 Steps 1–5；P2 仅在不扩大架构范围时一并修复。

执行结果：多轮独立复审先后发现 recovery 期间陈旧 `speech_stopped`、TTS 旧回调跨轮污染、模型/空白 secret 语义、close reason 脱敏、连续断线覆盖/静默提交 partial，以及 App 在同步发布下一条 review 后又将其清空的 UI 竞态。全部按失败测试 → 修复 → 定向/全量/浏览器/Docker 回归闭环；最终复审 Critical/Important/Minor 均为 0 后进入提交。

- [x] **Step 8: 最终提交验证记录，不 push**

```bash
git add docs/superpowers/plans/2026-08-02-realtime-voice-resilience.md
git commit -m "docs: record realtime voice resilience verification"
```

最终报告必须列出每个完成条件的 `done/partial/not_done`、执行过的命令及退出码、真实浏览器/麦克风是否完成、Docker 是否保留原卷。未经用户明确要求，不执行 `git push`。

## 自检结果

- 规格覆盖：设计第 5–8 节分别映射 Task 1–6；浏览器、静态资源和容器验收映射 Task 7–8；8 条完成条件均有测试或运行门禁。
- 占位扫描：计划未使用未定义实现占位；每个代码任务均包含具体失败测试、失败预期、实现接口、通过命令和提交边界。
- 类型一致性：统一使用 `AsrConnectionEvent`、`TranscriptReviewItem.source`、`VoiceUiStatus`、`TtsPlaybackInterruptedError`、`attachWebSocketHeartbeat()`；App、pipeline、组件和测试名称一致。
- 架构卫生：新纯逻辑分别进入 3 个聚焦模块；不继续把生命周期、worklet 探测和心跳逻辑堆入 `App.tsx` 或 `realtime-voice.ts`。
- 数据安全：Playwright 强制 memory 隔离；Docker 只 rebuild/recreate，不执行 `down -v`、reset、purge 或数据库删除。
