# 设计：专访原始语音留存与回放（Phase 2）

- 日期：2026-06-21
- 状态：待实现（Phase 1 证据链已合入 main）
- 依赖：Phase 1 的冷热分层 + RawMaterialViewer

## 1. 背景
Phase 1 做了文本专访稿 + AI 思考 + 旁注 + 轮次级证据链 + 冷热拆分；音频明确推迟到 Phase 2。本期：把**受访者的原始语音**留存、可回放，并接入证据链查看器。

实测架构：级联语音路径在浏览器端，`src/realtime/cascadedAsrSource.ts` 用 `getUserMedia` 持有麦克风 `MediaStream`（有可注入的 `getMicStream`）。→ **受访者音频可在前端用 MediaRecorder 捕获**。

## 2. 范围（v1）
- **捕获**：受访者麦克风音频，**整场一段**录音（MediaRecorder on 级联麦克风流）。
- **存储**：音频字节存独立 SQLite 表 `interview_audio`（与 ProductState blob 分离，绝不进全量 PUT）。
- **回放**：RawMaterialViewer 顶部加 `<audio controls>`，播整场录音。
- **治理**：purge（interviews/all）删音频；上传需 confirm 之外的常规鉴权（全局 auth hook 已覆盖）。

### 非目标（Phase 2.x / 未来）
- 主持人 TTS 音频留存、**逐轮音频对齐**（整场播放即可，时间戳对齐留后续）。
- 音频进导出包（体积大；export 暂只记元数据，音频靠 GET 端点取；purge 仍删音频以闭合隐私）。
- 文本路（打字）无音频——天然不适用。

## 3. 存储
新表（放在 Phase 1 的 raw-material.sqlite 同库或新 audio.sqlite；采用**新 AudioRepository**，镜像 RawMaterialRepository 双实现）：
```sql
CREATE TABLE IF NOT EXISTS interview_audio (
  session_id  TEXT PRIMARY KEY,
  audio       BLOB NOT NULL,        -- 整场录音字节(webm/opus)
  mime        TEXT NOT NULL,        -- 如 audio/webm;codecs=opus
  byte_size   INTEGER NOT NULL,
  duration_ms INTEGER,
  created_at  TEXT NOT NULL
);
```
体积估算：Opus 24kbps，30 分钟 ≈ 5MB，base64 ≈ 7MB，**落在现有 28MB body 限内**，v1 单请求上传即可（>28MB 的超长场分片留未来）。

`AudioRepository` 接口：`get(sessionId): InterviewAudio | undefined`、`put(InterviewAudio)`、`delete(sessionId)`、`deleteAll()`、`has(sessionId): boolean`。内存（Map）+ SQLite（node:sqlite BLOB）双实现。

类型：
```ts
export interface InterviewAudio {
  sessionId: string;
  audio: Uint8Array;     // 字节
  mime: string;
  byteSize: number;
  durationMs?: number;
  createdAt: string;
}
```

## 4. 端点
- `POST /api/sessions/:id/audio` — body `{ audioBase64: string; mime: string; durationMs?: number }`；解码 base64 → `AudioRepository.put`；返回 `{ ok, byteSize }`。鉴权走全局 hook。
- `GET /api/sessions/:id/audio` — 取字节，设 `Content-Type: <mime>` + `Content-Length`，流式返回；不存在 404。
- `GET /api/sessions/:id/audio/meta` —（可选）返回 `{ exists, mime, byteSize, durationMs }`，供查看器判断是否显示播放器（避免拉整段字节只为判存在）。

## 5. 前端捕获
- 新模块 `src/realtime/sessionAudioRecorder.ts`：`createSessionAudioRecorder(stream: MediaStream)` → `{ start(), stop(): Promise<{ blob: Blob; mime: string; durationMs: number }> }`，内部 `new MediaRecorder(stream, { mimeType })`（择优 `audio/webm;codecs=opus`），`ondataavailable` 累积 chunks，stop 时合成 Blob + 记时长。
- `cascadedAsrSource` 加可选 `onMicStream?: (stream: MediaStream) => void`，在 `getUserMedia` 拿到流后回调（不改 ASR 行为）。
- 语音起停 wiring（App.tsx / InterviewView 的 voice 启停处）：voice 开始 → 拿到 stream 时 `recorder.start()`；专访 /end 时 → `recorder.stop()` → `productApiClient.uploadSessionAudio(sessionId, base64, mime, durationMs)`。失败只告警、不阻塞结束（音频是增强，丢了也不挡正常结束）。

## 6. 回放 UI
- `productApiClient`：`getSessionAudioMeta(sessionId)`、`uploadSessionAudio(...)`；播放直接用 `<audio controls src={`${base}/api/sessions/${id}/audio`}>`。
- `RawMaterialViewer`：加载时并查 audio meta；若 `exists`，在顶部渲染"🎧 整场录音"播放器（用 lucide 图标，不用 emoji）。无则不显示。

## 7. 治理（隐私闭环）
- purge：`createScopedPurge`/`createPurgedProductState` 对应的路由层在清热/冷层后，调 `audioRepository.deleteAll()`（all）或按被清 sessionId `delete`（interviews）。
- export：v1 不打包音频字节（体积），但在导出报告里加 `audioSessions: string[]`（有录音的 sessionId 列表）做记录；音频本体靠 GET 端点。**purge 必删音频**（隐私优先）。

## 8. 测试
- TDD：AudioRepository 内存 + SQLite（put/get/delete/deleteAll/has，BLOB 往返、二进制完整）。
- 路由：POST 上传→GET 取回字节一致、404、meta；purge 清音频；base64 解码正确。
- 前端：sessionAudioRecorder 用注入的假 MediaRecorder/stream 单测 start/stop/blob 合成（jsdom 下 MediaRecorder 不可用 → 注入 fake）。
- **无法 headless 验证**：真实麦克风 → 录音 → 上传 这条链，需用户手动跑一次真实语音专访验证（硬件依赖，注明）。

## 9. 范围边界 / 风险
- v1 整场单段，无逐轮对齐；无主持人音频；export 不含音频字节。
- 大文件：>28MB（超长场）v1 不支持分片，上传会被 body 限拦——记 warn，留未来分片。
- MediaRecorder mimeType 浏览器差异：择优探测 `isTypeSupported`，回退 `audio/webm`。
- 隐私：音频是最敏感数据，purge 必删；GET 端点走全局鉴权；不进导出 JSON 降低泄露面。
