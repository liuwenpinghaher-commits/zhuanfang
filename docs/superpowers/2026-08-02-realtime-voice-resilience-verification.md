# 实时语音韧性最终验证记录

日期：2026-08-02
分支：`codex/realtime-voice-resilience`
基线：`b4e03d93`
最终功能提交：`17918eef`
验证范围：AudioWorklet/ORT 生产资源、ASR 生命周期和握手、连续断线人工确认边界、TTS 中断隔离、WebSocket 心跳与脱敏、空白密钥语义、Docker 与真实浏览器麦克风运行态。

## 真实运行发现与根因修复

1. **AudioWorklet 生产加载失败**：SPA fallback 把缺失 worklet 返回为 HTML，导致 `addModule()` 抛 `AbortError`。现已补齐 VAD/ORT 生产资源、正确 MIME、白名单静态服务和未知资源专用 404；静态 smoke 覆盖四组 ORT `.mjs + .wasm`。
2. **ASR 会中短暂断线后终止**：麦克风图与 socket 生命周期耦合，缺少有限退避和旧 socket 隔离。现改为一次性音频图、最多五次指数退避、每个 socket generation 隔离和致命关闭码快失败。
3. **代理过早 ready 和模型失效循环**：上游 TCP `open` 被误当作 provider ready，`session.update` 在 `session.created` 前丢失，空白模型未回默认。现等待 `session.created`，排队有限大小的 `session.update`，主模型失败只切一次 fallback；默认模型为：
   - 主模型：`qwen3.5-omni-flash-realtime`
   - fallback：`qwen3-omni-flash-realtime`
4. **连续断线可能丢失或静默提交 partial**：recovery review 期间再次断线曾覆盖冻结内容，后续修复又一度把第二次 partial 当作 final。最终实现为有序人工确认队列：每个断线 partial 都逐项显示并要求确认/丢弃；其间 provider final 与后续内容按时间顺序保留，确认前不会进入权威专访内容。
5. **TTS 旧回调跨轮污染**：客户端异常断线会停止旧排队音频；服务端用 `synthesisGeneration + AbortSignal` 阻断取消后的旧 `onAudio/onComplete/onError` 污染下一轮。
6. **配置诊断与运行时不一致**：仅空白字符的 secret 曾在 config、capabilities、provider 和 ASR/TTS WS 中判断不同。现统一 trim 后非空语义；空白主 key 不会阻断有效备用 key。
7. **关闭信息可能泄露敏感内容**：WebSocket close reason 与结构化日志共用脱敏和 UTF-8 长度限制，覆盖 Authorization、token、cookie、instructions、逐字稿和音频载荷变体。
8. **连续确认时 UI 会清空下一条待审尾段**：pipeline 在确认当前 recovery partial 时会同步发布队列中的下一项，App 随后的旧清理逻辑又把新项清空。现通过 `runVoiceReviewAction()` 固定“清当前 ref/界面 → 执行 pipeline action”的顺序；真实 Playwright 覆盖连续两次断线、两次确认和最终 turn 顺序。

## 完成矩阵

| 门禁 | 状态 | 证据 |
| --- | --- | --- |
| ASR-1 麦克风/AudioContext 只创建一次 | done | 资源复用与会中 socket 替换回归通过 |
| ASR-2 五次指数退避、停止和致命码快失败 | done | `asrConnectionLifecycle`、`cascadedAsrSource` 回归通过 |
| ASR-3 陈旧 socket 隔离 | done | 旧 socket 迟到事件不污染新连接 |
| DATA-1 partial 确认前零权威写入 | done | pipeline 与 Playwright 故障注入通过 |
| DATA-2 连续断线逐项确认且 final 不丢失 | done | confirm、discard、三次连续断线回归通过 |
| UI-1 reconnecting/degraded/exhausted 可见且文字可继续 | done | 组件测试与 Playwright 通过 |
| API-1 双向心跳、真实 ready 边界和定时器清理 | done | API 集成测试；最终容器真实麦克风 132 秒无断线 |
| API-2 日志与 close reason 无逐字稿、音频和密钥 | done | 复合脱敏测试与最终容器日志标记扫描通过 |
| CFG-1 空白/备用 secret 语义一致 | done | config、capabilities、provider、ASR/TTS WS 回归通过 |
| TTS-1 中断不重播且旧回调不污染下一轮 | done | client sink、pipeline 与 server generation 回归通过 |
| OPS-1 worklet/ORT 生产资源与 404 契约 | done | Docker smoke 与 Playwright 通过 |
| 真人语音内容质量 | partial | 真实麦克风和真实 provider 路径可用；最终候选完成 132 秒稳定性检查，但没有围绕指定 AI Native 主题完成完整真人口述专访，不能把稳定性门禁冒充内容质量 PASS |

## 工程验证

在最终候选工作树中执行：

```text
npm run typecheck
  exit 0

REAL_PROVIDER_SMOKE=off npm test -- --run
  164 passed files, 2 skipped files
  1740 passed tests, 16 skipped tests

npm run build
  exit 0
  VAD worklet、四组 ORT .mjs/.wasm 产物存在

npx playwright test tests/e2e/voice-resilience.spec.ts --project=chromium
  4 passed

npm run smoke:voice-static -- http://127.0.0.1:3210
  voice_static_smoke_pass

git diff --check
  exit 0
```

## Docker 与真实浏览器证据

- compose project：`10`；容器：`10-zhuanfang-1`。
- 最终镜像 ID：`sha256:aa719020b368d5197f8fdcb93063abb3198386f382ea0a7576c8ef8fe7ca3e74`；容器镜像与 `zhuanfang:local` tag 一致。
- 容器 `healthy`，restart count 为 `0`。
- 原数据卷仍为 `10_zhuanfang-data:/app/.data`；未执行 `down -v`、reset、purge、数据库删除或卷删除。
- 使用 Codex In-app Browser 刷新并确认实际加载最终 bundle：`/assets/index-BJCgcJGf.js`。
- 真实麦克风连续运行 132 秒：页面持续显示“正在听”和“停止录音”；新增 warning/error 为 `0`；正常停止后“开始录音”恢复。
- 同期容器日志计数：upstream close `0`、upstream error `0`、heartbeat timeout `0`、fallback `0`、敏感 payload marker `0`。
- 控制台不再出现 `Unable to load a worklet's module`，正常路径没有“语音兼容模式”。
- 最终独立复审：Critical `0`、Important `0`、Minor `0`；App review helper、pipeline 队列和 TTS factory 注入链路均无阻塞项。
- ASR PCM capture 仍使用浏览器已弃用的 `ScriptProcessorNode` fallback；这不是本次 AudioWorklet 模块加载失败，当前未造成断线，但后续应迁移到独立 AudioWorklet PCM capture。

## 交付边界

- 不 push。
- 不删除或重置真实数据与 Docker 卷。
- 不用 fake mic、mock provider 或静音探针冒充真人内容质量验收。
