# 实时专访语音韧性设计

## 1. 背景与问题

生产环境曾缺少 `/vad/vad.worklet.bundle.min.js`，未知静态资源又被 SPA fallback 返回为 HTML，导致 `AudioWorklet.addModule()` 抛出 `AbortError`。浏览器随后降级到 `ScriptProcessorNode`，控制台出现弃用警告。

该静态资源问题已由 `a12202d6` 修复，但现有实时语音仍有更深的会中断线问题：

- `cascadedAsrSource` 只在首次连接阶段重试；收到 `proxy.connected` 后，任何 `error/close` 都直接上报永久断线。
- `App` 收到 `onConnectionLost` 后立即关闭整条实时语音管线。
- 断线事件没有保留 WebSocket close code/reason，无法区分浏览器网络、代理、百炼上游或正常关闭。
- 重连逻辑与麦克风初始化耦合；直接复用当前 `attemptConnect()` 会反复创建音频图和 `AudioContext`。
- 断线前的 partial transcript 没有明确恢复语义，可能丢失或被误当成 final。
- AudioWorklet 降级只写 console warning，用户不知道当前处于兼容模式。

## 2. 目标

1. 短暂的浏览器、代理或百炼上游断线不结束专访，能够自动恢复原语音会话。
2. 重连复用同一麦克风流和音频处理图，不重复申请权限、不重复采集、不泄漏资源。
3. 只有 provider final transcript 能自动提交；断线前未 final 的尾段进入待确认区。
4. 重连过程和降级状态对用户可见，但不阻塞文字输入和已完成回合。
5. close code/reason、重试次数和断线阶段可观测，同时不记录逐字稿、音频、密钥或 token。
6. AudioWorklet 静态资源在生产构建、服务端静态路由和容器运行态均可验证。

## 3. 非目标

- 不修改专访问题生成、记忆召回、引用或档案提取逻辑。
- 不在断线期间无限缓存原始 PCM，也不在恢复后静默补发用户可能已经忘记的语音。
- 不自动重播已经开始播放的完整 TTS，避免重复语音。
- 不切换到 LiveKit 或更换百炼 provider。
- 不用无限重试掩盖永久配置错误、鉴权失败或明确的服务端拒绝。

## 4. 方案选择

### 方案 A：只保留 AudioWorklet 静态资源修复

能够消除当前 `AbortError`，但不能解决会中网络抖动和上游关闭，拒绝采用。

### 方案 B：在现有 `start()` 外层再次调用连接函数

改动较小，但会重复执行 `startMic()`，容易创建多个麦克风音频图；也没有 partial 隔离和状态机，拒绝采用。

### 方案 C：端到端有状态恢复

将麦克风、ASR socket、转写状态和业务提交边界分开管理；浏览器和代理共同提供恢复与可观测能力。该方案作为最终设计。

## 5. 浏览器端架构

### 5.1 ASR 生命周期状态机

新增显式状态：

```text
idle → connecting → ready
ready → reconnecting → ready
reconnecting → exhausted
idle/connecting/ready/reconnecting/exhausted → stopped
```

状态约束：

- `start()` 只允许从 `idle` 进入；麦克风和音频图只初始化一次。
- `stop()` 是终态且幂等；手动停止、结束专访、切换会话都不会触发重连。
- 只有收到服务端 `proxy.connected` 才进入 `ready`。
- 连接成功后的异常关闭进入 `reconnecting`，不再直接关闭业务会话。
- 恢复耗尽才进入 `exhausted` 并通知 `App` 结束语音部分。

### 5.2 麦克风与 Socket 解耦

`startMic()` 负责一次性创建并持有：

- `MediaStream`
- `AudioContext`
- 输入节点、分析节点和音频处理节点
- Silero VAD controller

Socket 重连只替换 WebSocket，不重新调用 `getUserMedia()`，不重新创建音频图。音频回调根据 socket 状态发送：只有 `ready` 且 socket 为 `OPEN` 时发送 PCM；`connecting/reconnecting` 时丢弃实时帧，不缓存。

### 5.3 重连策略

- 会中自动重连最多 5 次。
- 退避基数为 500ms，指数序列为 500ms、1s、2s、4s、8s；每次增加 0–20% 抖动。
- close code `1000` 且由本地 `stop()` 发起：不重连。
- 明确不可恢复的 close code（鉴权/配置错误，如代理 `4001`）：直接 `exhausted`。
- 网络异常、`1006`、上游临时关闭和代理错误：允许重连。
- 每次新 socket 打开后重新发送同一份 `session.update`，收到 `proxy.connected` 后恢复发送音频。
- 重连成功后重试计数归零；新一次独立断线重新获得完整重试预算。

为保证测试可确定性，退避等待、随机抖动和时钟通过选项注入，生产使用真实实现。

### 5.4 partial transcript 恢复边界

ASR source 跟踪当前 provider partial 和最后一个 provider final：

- final 已经进入现有 turn assembler，保持既有权威语义。
- socket 异常关闭时，如存在“最后一次 final 之后的新 partial”，触发 `onRecoveryTranscript`。
- `onRecoveryTranscript` 只包含文本与非敏感原因码，不带原始音频。
- pipeline 将该文本送入现有待确认转写区；用户可编辑、确认或丢弃。
- 该文本在确认前不调用 `sendInterviewTurn()`，不创建 user turn。
- 开始新 socket 前清空 ASR provider partial，防止新旧会话文本拼接。

### 5.5 UI 状态

实时语音状态增加：

- `reconnecting`：显示“语音连接恢复中，请稍候”，录音按钮保持已开启但不可重复触发。
- `degraded`：AudioWorklet 失败并使用兼容模式时显示“语音兼容模式”，不把 console warning 当唯一信号。
- `exhausted`：显示“语音连接未恢复，已保留本场文字专访”，停止语音资源但不结束业务 session。

重连成功后恢复 `listening`，并给出一次短暂的“语音连接已恢复”提示。

## 6. AudioWorklet 与兼容模式

### 6.1 生产资源契约

生产必须包含：

- `/vad/vad.worklet.bundle.min.js`
- Silero VAD ONNX 模型
- ORT WASM/MJS 资源

服务端对缺失的 asset-like URL 返回 plain-text 404，绝不返回 `index.html`。容器 smoke 必须验证 worklet 返回 200、JavaScript MIME 且正文不是 HTML。

### 6.2 降级信号

`@ricky0123/vad-web` 内部可回退到 ScriptProcessor，但没有公开实际 processor 类型。应用层在创建 VAD 前执行 `probeVadWorkletCapability()`：同源 fetch worklet 并校验 JavaScript MIME，再用一个短生命周期 `AudioContext.audioWorklet.addModule()` 验证浏览器可执行该模块，最后关闭探测 context。任一步失败即标记 `degraded`，随后仍允许 `MicVAD` 自己回退。该探测不修改 vendor 文件，也不读取私有字段。

降级不等于断线：它只降低音频调度质量。ASR 自身当前仍使用 ScriptProcessor；本批不同时重写完整 PCM capture worklet，以免把恢复修复扩大成音频采集架构迁移。后续可独立将 ASR PCM capture 迁移到自有 AudioWorklet。

## 7. 服务端代理韧性

### 7.1 心跳

服务端为浏览器 socket 和 DashScope socket 维护 WebSocket ping/pong：

- 每 15 秒检查一次。
- 连续两个周期未收到 pong（约 30 秒）才 terminate 对应死连接，避免一次主线程或上游抖动造成误杀。
- 定时器在任一侧 close/error 后立即清理，不允许泄漏。
- 浏览器原生 WebSocket 会自动响应协议级 ping，不需要应用层伪造消息。

心跳的目的不是隐藏断线，而是让半开连接快速进入浏览器重连状态。

### 7.2 关闭原因与日志

新增结构化事件：

- `realtime_proxy_browser_closed`
- `realtime_proxy_upstream_closed`
- `realtime_proxy_error`
- `realtime_proxy_heartbeat_timeout`

字段仅包含：session ID、方向、close code、截断后的非敏感 reason、连接持续时间和阶段。禁止记录 Authorization、请求头、逐字稿、音频 payload、session instructions。

代理继续把上游关闭码钳制到可发送范围，并把 reason 限制在 123 字节；浏览器端保留收到的 code/reason 供恢复决策和 UI 诊断。

## 8. TTS 失败策略

TTS WebSocket 在一次 speak 中途失败时：

- 不从头自动重播，避免已听内容重复。
- 向 pipeline 抛出带阶段的错误。
- UI 显示“本轮语音播放中断，文字内容已保留”。
- 关闭损坏 socket；下一轮 speak 按现有惰性连接机制创建新 socket。
- 专访继续处于可输入状态，不关闭 ASR。

## 9. 接口变化

`AsrSource` 增加可选恢复能力回调：

```ts
type AsrConnectionState = "connecting" | "ready" | "reconnecting" | "exhausted" | "stopped";

interface AsrConnectionEvent {
  state: AsrConnectionState;
  attempt: number;
  maxAttempts: number;
  code?: number;
  reason?: string;
}
```

`CreateBrowserAsrSourceOptions` 增加：

- `onConnectionStateChange`
- `onRecoveryTranscript`
- `maxMidSessionReconnectAttempts`，默认 5
- `midSessionReconnectBaseDelayMs`，默认 500
- 测试用 `random` / `wait` 注入

保留现有 `onConnectionLost` 作为耗尽后的兼容回调，避免一次性破坏调用方。

## 10. 测试策略

### 10.1 单元测试

- 首次连接失败仍按既有语义重试。
- `ready` 后异常关闭进入 `reconnecting` 并成功恢复。
- 重连不再次调用 `getUserMedia()`，不新增 AudioContext/processor。
- 重连耗尽只调用一次 `onConnectionLost`。
- 本地主动 stop 不重连、不报断线。
- 不可恢复 close code 不重试。
- 重连前 partial 进入 `onRecoveryTranscript`，final 不重复进入。
- 新旧 socket 事件隔离，陈旧 socket 不能污染新连接状态。
- 退避序列和抖动边界正确。
- 心跳定时器创建和清理无泄漏。
- 代理透传安全 close code/reason，日志不包含 transcript 和凭据。
- TTS 中断不自动重播，下一轮可重新建连。

### 10.2 组件与浏览器测试

- `reconnecting/degraded/exhausted` 状态文案可见。
- 待确认尾段可编辑、确认、丢弃，确认前没有业务 POST。
- 故障注入 WebSocket 在短暂断开后恢复，业务 session ID 不变。
- 真实生产静态服务返回正确 worklet MIME。

### 10.3 运行验证

- `npm run typecheck`
- 定向 realtime Vitest
- `REAL_PROVIDER_SMOKE=off npm test -- --run`
- `npm run build`
- Playwright 语音故障注入用例
- Docker 容器重建后检查健康接口、worklet 资源、未知 asset 404 和 WebSocket 恢复 smoke

真实麦克风/provider 复测需要浏览器麦克风权限；执行到该门禁时单独请求确认。

## 11. 完成条件

1. AudioWorklet 生产资源契约通过，正常浏览器不再触发该模块加载 `AbortError`。
2. 一次可恢复的会中 ASR 断线不会结束专访，5 次预算内可恢复。
3. 恢复期间不重复创建麦克风资源，不发送缓存音频，不产生重复回合。
4. 未 final 尾段只进入待确认区，确认前不落库。
5. 永久失败仍保留文字专访并给出明确原因。
6. 浏览器与代理 close 原因可观测且不泄露敏感内容。
7. TTS 中断不重复播放，下一轮可以继续。
8. 单元、全量、构建、Playwright 和容器 smoke 全部通过。
