# 专访原始语音留存与回放（Phase 2）Implementation Plan

> REQUIRED SUB-SKILL: subagent-driven-development. Steps use `- [ ]`.

**Goal:** 留存受访者整场原始语音、可回放、接入证据链查看器，存独立 SQLite 表不碰 ProductState blob。

**Architecture:** 客户端 MediaRecorder 录级联麦克风流 → /end 时 base64 上传 → 独立 `interview_audio` 表（AudioRepository 双实现，BLOB）→ GET 端点流式回放 → RawMaterialViewer 顶部 `<audio>`。purge 删音频。

参考设计：`docs/superpowers/specs/2026-06-21-interview-audio-phase2-design.md`

---

## M1 — 类型 + AudioRepository 内存实现

### Task 1: InterviewAudio 类型 + AudioRepository 接口 + 内存实现（TDD）
**Files:** Create `apps/api/src/audio-repository.ts` + `apps/api/src/audio-repository.test.ts`；Modify `src/domain/types.ts`

- [ ] **Step 1: 类型**（types.ts，放 InterviewRawMaterial 之后）
```ts
export interface InterviewAudio {
  sessionId: string;
  audio: Uint8Array;
  mime: string;
  byteSize: number;
  durationMs?: number;
  createdAt: string;
}
```

- [ ] **Step 2: 失败测试**（audio-repository.test.ts）
```ts
import { describe, it, expect } from "vitest";
import { createInMemoryAudioRepository } from "./audio-repository";
import type { InterviewAudio } from "../../../src/domain/types";

const mk = (id: string): InterviewAudio => ({
  sessionId: id, audio: new Uint8Array([1, 2, 3, 4]), mime: "audio/webm", byteSize: 4,
  durationMs: 1000, createdAt: "2026-06-21T00:00:00.000Z"
});

describe("in-memory AudioRepository", () => {
  it("put/get 往返字节完整, has, 不存在 undefined/false", () => {
    const r = createInMemoryAudioRepository();
    expect(r.get("s1")).toBeUndefined();
    expect(r.has("s1")).toBe(false);
    r.put(mk("s1"));
    expect(Array.from(r.get("s1")!.audio)).toEqual([1, 2, 3, 4]);
    expect(r.has("s1")).toBe(true);
  });
  it("delete / deleteAll", () => {
    const r = createInMemoryAudioRepository();
    r.put(mk("s1")); r.put(mk("s2"));
    r.delete("s1");
    expect(r.has("s1")).toBe(false); expect(r.has("s2")).toBe(true);
    r.deleteAll();
    expect(r.has("s2")).toBe(false);
  });
});
```

- [ ] **Step 3: 运行确认失败** — `npx vitest run apps/api/src/audio-repository.test.ts`

- [ ] **Step 4: 实现**（audio-repository.ts）
```ts
import type { InterviewAudio } from "../../../src/domain/types";

export interface AudioRepository {
  get(sessionId: string): InterviewAudio | undefined;
  has(sessionId: string): boolean;
  put(audio: InterviewAudio): void;
  delete(sessionId: string): void;
  deleteAll(): void;
}

export function createInMemoryAudioRepository(): AudioRepository {
  const store = new Map<string, InterviewAudio>();
  return {
    get: (id) => store.get(id),
    has: (id) => store.has(id),
    put: (a) => { store.set(a.sessionId, a); },
    delete: (id) => { store.delete(id); },
    deleteAll: () => { store.clear(); }
  };
}
```

- [ ] **Step 5: 通过** — `npx vitest run apps/api/src/audio-repository.test.ts` PASS
- [ ] **Step 6: Commit** — `git add` 上述3文件; `git commit -m "feat(audio): InterviewAudio 类型 + AudioRepository 内存实现(TDD)"`

## M2 — SQLite AudioRepository（BLOB）

### Task 2: SQLite 实现（node:sqlite BLOB）TDD
**Files:** Create `packages/db/src/sqlite-audio-repository.ts` + `.test.ts`

- [ ] **Step 1: 失败测试**
```ts
import { describe, it, expect } from "vitest";
import { createSqliteAudioRepository } from "./sqlite-audio-repository";
import type { InterviewAudio } from "../../../src/domain/types";
const mk = (id: string): InterviewAudio => ({
  sessionId: id, audio: new Uint8Array([9, 8, 7, 0, 255]), mime: "audio/webm", byteSize: 5,
  durationMs: 2000, createdAt: "2026-06-21T00:00:00.000Z"
});
describe("sqlite AudioRepository", () => {
  it("BLOB 往返字节完整, has, delete/deleteAll", () => {
    const r = createSqliteAudioRepository({ dbPath: ":memory:" });
    r.put(mk("s1"));
    expect(Array.from(r.get("s1")!.audio)).toEqual([9, 8, 7, 0, 255]);
    expect(r.get("s1")!.mime).toBe("audio/webm");
    expect(r.has("s1")).toBe(true);
    expect(r.get("missing")).toBeUndefined();
    r.delete("s1"); expect(r.has("s1")).toBe(false);
    r.put(mk("s2")); r.deleteAll(); expect(r.has("s2")).toBe(false);
  });
});
```
- [ ] **Step 2: 失败** — `npx vitest run packages/db/src/sqlite-audio-repository.test.ts`
- [ ] **Step 3: 实现** — 镜像 `packages/db/src/sqlite-raw-material-repository.ts` 的 `node:sqlite`（`DatabaseSync`）写法。表 DDL 见设计 §3。**关键**：BLOB 存取——`put` 传 `audio`（Uint8Array，node:sqlite 接受 Uint8Array 作 BLOB 参数）；`get` 时返回列是 `Uint8Array`，原样放回 `audio`，并 `byteSize` 用 `audio.byteLength` 兜底。`durationMs` 可空。:memory: 跳过 mkdir（同 raw-material 实现的守卫）。先读 raw-material sqlite 实现对齐 import/路径/cast 风格。
- [ ] **Step 4: 通过**
- [ ] **Step 5: Commit** — `git commit -m "feat(db): SQLite AudioRepository + interview_audio BLOB 表(TDD)"`

## M3 — 端点 + 装配

### Task 3: 上传/回放/meta 端点 + server 装配 TDD
**Files:** Create `apps/api/src/routes/audio.ts` + `.test.ts`；Modify `apps/api/src/server.ts`

- [ ] **Step 1: 失败测试**（用 buildApiServer({env:{}}) 注入内存 AudioRepository；先给 BuildApiServerOptions 加可选 `audioRepository?`，同 Phase1 rawMaterialRepository 模式）
  - POST `/api/sessions/s1/audio` body `{ audioBase64: Buffer.from([1,2,3]).toString("base64"), mime:"audio/webm", durationMs:500 }` → 200 `{okःtrue}`；
  - GET `/api/sessions/s1/audio` → 200，body 字节等于 [1,2,3]，`content-type` 为 audio/webm；
  - GET `/api/sessions/missing/audio` → 404；
  - GET `/api/sessions/s1/audio/meta` → `{ exists:true, mime:"audio/webm", byteSize:3, durationMs:500 }`。
  （fastify inject 取二进制：`response.rawPayload` 是 Buffer，断言 `Array.from(response.rawPayload)`。）
- [ ] **Step 2: 失败**
- [ ] **Step 3: 实现**（audio.ts）
```ts
import type { FastifyInstance } from "fastify";
import type { AudioRepository } from "../audio-repository";

export async function registerAudioRoutes(server: FastifyInstance, audioRepo: AudioRepository): Promise<void> {
  server.post("/api/sessions/:id/audio", async (request, reply) => {
    const id = (request.params as { id?: string }).id ?? "";
    const body = request.body as { audioBase64?: unknown; mime?: unknown; durationMs?: unknown } | undefined;
    if (typeof body?.audioBase64 !== "string" || typeof body?.mime !== "string") {
      return reply.code(422).send({ error: "audio requires audioBase64(string) + mime(string)." });
    }
    const audio = new Uint8Array(Buffer.from(body.audioBase64, "base64"));
    audioRepo.put({
      sessionId: id, audio, mime: body.mime, byteSize: audio.byteLength,
      ...(typeof body.durationMs === "number" ? { durationMs: body.durationMs } : {}),
      createdAt: new Date().toISOString()
    });
    return { ok: true, byteSize: audio.byteLength };
  });

  server.get("/api/sessions/:id/audio", async (request, reply) => {
    const id = (request.params as { id?: string }).id ?? "";
    const a = audioRepo.get(id);
    if (!a) return reply.code(404).send({ error: "No audio for session." });
    return reply.header("content-type", a.mime).header("content-length", String(a.byteSize)).send(Buffer.from(a.audio));
  });

  server.get("/api/sessions/:id/audio/meta", async (request) => {
    const id = (request.params as { id?: string }).id ?? "";
    const a = audioRepo.get(id);
    return a ? { exists: true, mime: a.mime, byteSize: a.byteSize, durationMs: a.durationMs ?? null } : { exists: false };
  });
}
```
（注意 `new Date().toISOString()` 在本仓 domain 层被禁，但**路由层允许**——raw-material/state 路由都直接用了 `new Date().toISOString()`，照其先例。）
- [ ] **Step 4: server.ts 装配** — 同 Phase1 rawMaterialRepository：`createDefaultAudioRepository`（sqlite 同目录 `audio.sqlite`，内存路径→内存），`BuildApiServerOptions.audioRepository?`，`void server.register(s => registerAudioRoutes(s, audioRepository))`。
- [ ] **Step 5: 通过 + tsc** — `npx vitest run apps/api/src/routes/audio.test.ts && npx tsc -p apps/api/tsconfig.json`
- [ ] **Step 6: Commit** — `git commit -m "feat(api): 语音上传/回放/meta 端点 + 装配"`

## M4 — 治理

### Task 4: purge 删音频 TDD
**Files:** Modify `apps/api/src/routes/state.ts` + `.test.ts`、`server.ts`、export 报告加 audioSessions
- [ ] **Step 1: 失败测试**（state.test.ts）：注入内存 audioRepo，put 一条；purge all → `audioRepo.has(...)===false`；export 报告含 `audioSessions: ["s1"]`（来自 audioRepo 的有音频 sessionId 列表 —— 给 AudioRepository 加 `listSessionIds(): string[]`，三处实现）。
- [ ] **Step 2: 失败 → Step 3: 实现** — state 路由 options 加 `audioRepository?`；purge all → `audioRepository?.deleteAll()`；interviews scope → 对被清 sessionId `delete`（简单起见 interviews 也 deleteAll，因清空 sessions）；export `{ ...report, audioSessions: audioRepository?.listSessionIds() ?? [] }`。AudioRepository 接口 + 双实现加 `listSessionIds()`（内存 `[...store.keys()]`；sqlite `SELECT session_id`）。server.ts state 注册传 audioRepository。
- [ ] **Step 4: 通过 + tsc**
- [ ] **Step 5: Commit** — `git commit -m "feat(governance): purge 删音频 + export 记录有音频会话(隐私闭环)"`

## M5 — 前端捕获

### Task 5: sessionAudioRecorder + cascade onMicStream + 上传 wiring
**Files:** Create `src/realtime/sessionAudioRecorder.ts` + `.test.ts`；Modify `src/realtime/cascadedAsrSource.ts`、`src/api/productApi.ts`、语音起停 wiring 处（grep `closeRealtimeVoiceSession`/级联启动，多在 `src/App.tsx` 或 `src/features/interview/InterviewView.tsx`）
- [ ] **Step 1: recorder TDD**（注入 fake MediaRecorder + fake stream，jsdom 无原生 MediaRecorder）
```ts
// createSessionAudioRecorder(stream, { recorderFactory }) 便于注入 fake
// 测：start 调 fake.start；stop 收集 ondataavailable 的 chunks 合成 Blob、返回 {blob, mime, durationMs>=0}
```
- [ ] **Step 2: 实现 recorder** — `createSessionAudioRecorder(stream, opts?)`：探测 `MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? 该 : "audio/webm"`；`start()` 记开始时间；`ondataavailable` push chunk；`stop()` → Promise（onstop 时合成 `new Blob(chunks,{type:mime})` + `durationMs = now-start`）。opts.recorderFactory 默认 `(s,m)=>new MediaRecorder(s,{mimeType:m})`。
- [ ] **Step 3: cascadedAsrSource onMicStream** — 接口加可选 `onMicStream?: (stream: MediaStream) => void`；在拿到 `stream`（getUserMedia 后，约 164 行）调用 `options.onMicStream?.(stream)`。不改 ASR 其它行为。**先读该文件确认插入点**。
- [ ] **Step 4: productApi** — `uploadSessionAudio(sessionId, blob): Promise<void>`：blob→arrayBuffer→base64→POST `/api/sessions/:id/audio` `{audioBase64, mime:blob.type, durationMs?}`。失败抛错（调用方 catch 仅告警）。`getSessionAudioMeta(sessionId)`：GET meta。
- [ ] **Step 5: wiring** — 在级联语音启动处把 `onMicStream` 接上：拿到 stream → `recorder = createSessionAudioRecorder(stream); recorder.start()`。在专访 /end（endInterviewSession）成功后：`if(recorder){ const {blob}=await recorder.stop(); productApiClient.uploadSessionAudio(session.id, blob).catch(()=>setNotice(warn...)); }`。**先读 wiring 真实结构**，最小侵入；音频失败绝不阻塞结束。
- [ ] **Step 6: tsc 干净** — `npx tsc -p tsconfig.json --noEmit`
- [ ] **Step 7: Commit** — `git commit -m "feat(web): 整场语音录制(MediaRecorder)+ /end 上传 + cascade onMicStream"`

## M6 — 回放 UI

### Task 6: RawMaterialViewer 音频播放器
**Files:** Modify `src/features/notes/RawMaterialViewer.tsx`、`src/api/productApi.ts`（若 meta 未加）
- [ ] **Step 1:** RawMaterialViewer 加载时并行 `getSessionAudioMeta(sessionId)`；若 `exists`，顶部渲染一块"整场录音"区：lucide `Headphones` 图标标题 + `<audio controls src={`${apiBase}/api/sessions/${sessionId}/audio`} />`（apiBase 取 productApi 的 base；若组件拿不到 base，给 productApi 暴露一个 `sessionAudioUrl(id)` helper 返回完整 URL）。无音频不渲染该区。
- [ ] **Step 2: tsc 干净**；手测留 M7。
- [ ] **Step 3: Commit** — `git commit -m "feat(web): 证据链查看器加整场录音播放器"`

## M7 — 回归 + 收尾
- [ ] **Step 1:** `npx tsc -p tsconfig.json --noEmit && npx tsc -p apps/api/tsconfig.json`
- [ ] **Step 2:** `npx vitest run` 全绿不回归
- [ ] **Step 3:** 端到端手测**（需用户/真实麦克风）**：跑一次真实级联语音专访 → /end → 档案页查看原始材料 → 顶部出现整场录音播放器、可播；`GET /api/state` 不含音频字节（在独立表）。**此步无法 headless 自动验证，须手动。**
- [ ] **Step 4: Commit（如有收尾）**

## 自审记录
- spec 覆盖：§3 存储→T1/T2；§4 端点→T3；§5 捕获→T5；§6 回放→T6；§7 治理→T4；§8 测试散各 Task + T7 手测兜底。
- 类型/命名一致：`AudioRepository`/`InterviewAudio`/`createSessionAudioRecorder`/`uploadSessionAudio`/`getSessionAudioMeta` 全程同名。
- 已知不可 headless 验证：真实麦克风录制→上传链（T7 Step3，硬件依赖，须手测）。
- YAGNI：v1 无逐轮对齐、无主持人音频、无音频进导出、无分片。
