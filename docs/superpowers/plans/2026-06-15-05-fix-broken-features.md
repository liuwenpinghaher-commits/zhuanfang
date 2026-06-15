# Phase 5: 修复坏功能 + 兑现承诺 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 播客不再因 TTS 400 而丢脚本/500；脚本由 LLM 生成；CosyVoice 端点修对；IntelTask 要么真调度、要么诚实改名。

**Architecture:** (1) 播客路由改为"先落库脚本、TTS 失败降级不报错"；(2) 新增 LLM 播客脚本生成；(3) spike 出 CosyVoice 正确的 DashScope 调用形态并替换；(4) 在 API 进程内加一个轻量定时器，按 `frequency`+`lastRunAt` 跑到期 IntelTask（并在 UI 文案说明"服务运行时生效"）。

**Tech Stack:** TypeScript, Fastify, vitest, DashScope CosyVoice。

---

### Task 1: 播客路由韧性 + LLM 脚本

**Files:**
- Modify: `apps/api/src/routes/podcast.ts` (先落库、TTS 包 try/catch)
- Create: `apps/api/src/intelligence/podcast-script-llm.ts`
- Modify: `src/domain/podcast.ts`（保留为离线 fallback）
- Test: `apps/api/src/routes/podcast.test.ts`（TTS 失败仍 200 且脚本在）

- [ ] **Step 1: 写失败测试** — 注入会抛错的 TTS client，断言 episode 仍生成、脚本保留、不 500

```ts
it("persists the episode + script even when TTS fails (no 500, no data loss)", async () => {
  const failingTts = { synthesize: async () => { throw new Error("TTS 400"); } };
  const server = buildApiServer({ bailianPodcastAudioClient: failingTts as never });
  // 先准备一个 note（用 demo 或先跑一次 finalize）……此处用 demo 数据里的首个 note
  const state = (await server.inject({ method: "GET", url: "/api/state" })).json();
  const noteId = state.notes[0]?.id ?? "note-x";
  const res = await server.inject({ method: "POST", url: "/api/podcast/episodes", payload: { noteId, format: "interview", voice: "longyuan_v3" } });
  expect(res.statusCode).toBe(200);
  const ep = res.json().episode;
  expect(ep.script?.length ?? ep.scriptText?.length ?? 0).toBeGreaterThan(0);
  expect(["audio-failed", "ready", "script-only"]).toContain(ep.status);
  await server.close();
});
```
> 字段名以 `PodcastEpisode` 类型为准（读 `types.ts`），测试里按实际字段断言。

- [ ] **Step 2: 跑测试确认失败**（当前 TTS 抛错 → 路由 500，脚本丢）。

- [ ] **Step 3: 路由改韧性**
`podcast.ts`：调整顺序——先生成脚本（Task 1 Step 5 的 LLM 或离线）、先 `repository.replaceState` 落库 episode（status `"script-only"`）；再 `try { const audio = await client.synthesize(...); episode.audioUrl = audio.audioUrl; episode.status = "ready"; } catch (e) { episode.status = "audio-failed"; console.warn(JSON.stringify({event:"llm_fallback",capability:"podcast_tts",error:String(e)})); }`；最后再落库一次。**TTS 失败绝不丢脚本、绝不 500。**

- [ ] **Step 4: 新增 LLM 脚本生成**
`apps/api/src/intelligence/podcast-script-llm.ts`：`generatePodcastScript(note, format, chatClient): Promise<string>`——基于 note 的 summary/saidTrack/learnedTrack 生成口播稿，反幻觉。`podcast.ts` 有 chatClient 时用它，失败回退现有 `src/domain/podcast.ts` 的模板。

- [ ] **Step 5: 跑测试 + 全量**，提交：
```bash
git add apps/api/src/routes/podcast.ts apps/api/src/intelligence/podcast-script-llm.ts apps/api/src/routes/podcast.test.ts
git commit -m "fix(podcast): persist script before TTS; LLM-generate script; TTS failure degrades gracefully"
```

---

### Task 2: 修对 CosyVoice TTS 端点（spike）

**Files:**
- Modify: `apps/api/src/providers/bailian.ts` (`createBailianPodcastAudioClient`, ~line 472)
- Create: `scripts/verify-tts.mjs`（一次性验证脚本）

- [ ] **Step 1: Spike —— 找到正确的 DashScope CosyVoice 调用形态**
当前 `POST /api/v1/services/audio/tts/SpeechSynthesizer` 返回 400。CosyVoice-v2/v3 在 DashScope 上通常走**异步任务**（`X-DashScope-Async`，提交后轮询）或 **WebSocket** 实时合成，而非该 REST 形态。写 `scripts/verify-tts.mjs`（仿 `scripts/verify-providers.mjs`，读 `.env.local` key），逐个试：
  (a) 异步任务端点 `POST /api/v1/services/aigc/multimodal-generation/generation` 或音频合成 task 端点 + 轮询；
  (b) WebSocket 实时合成 `wss://dashscope.aliyuncs.com/api-ws/v1/inference`。
跑 `node scripts/verify-tts.mjs`，记录哪个返回真实 audio url / 音频字节。**以官方文档 + 实测为准**（参考 https://help.aliyun.com/zh/model-studio/text-to-speech）。

- [ ] **Step 2: 按 spike 结果重写 synthesize**
用验证通过的端点/payload/解析替换 `createBailianPodcastAudioClient` 的实现；加 `AbortSignal.timeout`。

- [ ] **Step 3: 实测**：`node scripts/verify-tts.mjs` 返回可播放音频；跑 Task 1 的 podcast 测试改用真 client（可选，标 `it.skipIf(!process.env.DASHSCOPE_API_KEY)`）。

- [ ] **Step 4: 提交**
```bash
git add apps/api/src/providers/bailian.ts scripts/verify-tts.mjs
git commit -m "fix(tts): use the correct DashScope CosyVoice API (verified live)"
```

> 若 spike 后确认本账号/区域不支持 CosyVoice：在 ConfigView 把 TTS provider 标记为"未配置"，Task 1 的韧性已保证脚本不丢——此时诚实关闭即可。

---

### Task 3: IntelTask 真调度（或诚实改名）

**Files:**
- Create: `apps/api/src/intel-scheduler.ts`
- Modify: `apps/api/src/server.ts`（启动时挂调度器）
- Modify: `src/domain/intel.ts`（`isIntelTaskDue` 纯函数）
- Test: `src/domain/intel.test.ts`（isIntelTaskDue）

- [ ] **Step 1: 写失败测试** — `isIntelTaskDue` 按 frequency + lastRunAt 判到期
```ts
it("isIntelTaskDue respects frequency and lastRunAt", () => {
  const base = { id: "t", name: "n", keywords: ["a"], provider: "bailian", relatedThemeIds: [], relatedDebtIds: [], status: "active", createdAt: "2026-06-01T00:00:00Z" } as any;
  const now = new Date("2026-06-15T00:00:00Z");
  expect(isIntelTaskDue({ ...base, frequency: "manual" }, now)).toBe(false);
  expect(isIntelTaskDue({ ...base, frequency: "daily", lastRunAt: "2026-06-13T00:00:00Z" }, now)).toBe(true);
  expect(isIntelTaskDue({ ...base, frequency: "daily", lastRunAt: "2026-06-15T01:00:00Z" }, new Date("2026-06-15T02:00:00Z")), ).toBe(false);
  expect(isIntelTaskDue({ ...base, frequency: "weekly", lastRunAt: "2026-06-01T00:00:00Z" }, now)).toBe(true);
});
```

- [ ] **Step 2: 跑测试确认失败**（函数不存在）。

- [ ] **Step 3: 实现 `isIntelTaskDue`**（`src/domain/intel.ts`，纯函数，传入 `now: Date` 而非内部 `Date.now()`，便于测试）：`manual`→false；`active` 且 `(now - lastRunAt)` ≥ 1天(daily)/7天(weekly)（无 lastRunAt 视为到期）。

- [ ] **Step 4: 进程内调度器**
`apps/api/src/intel-scheduler.ts`：导出 `startIntelScheduler(repository, providerClients, intervalMs = 600000)`——`setInterval`，每次取 state、筛 `isIntelTaskDue(task, new Date())` 的任务、复用 Phase-11 的运行逻辑（提取 `routes/intel.ts` 里 run 的核心为可共享函数 `runIntelTaskOnce(state, task, clients)`）跑一遍、`replaceState`。返回 `stop()`。
`server.ts` 的 `startServer()` 里调用 `startIntelScheduler(...)`（仅真实启动时，不在 `buildApiServer` 测试路径）。

- [ ] **Step 5: UI 文案诚实化**
`IntelView.tsx`：在 frequency 旁注明"自动运行需 API 服务保持运行"；或若不实现调度（Step 4 跳过），把标题"自动化情报任务"改为"情报任务"并去掉 daily/weekly 选项。

- [ ] **Step 6: 跑测试 + 提交**
```bash
git add apps/api/src/intel-scheduler.ts apps/api/src/server.ts apps/api/src/routes/intel.ts src/domain/intel.ts src/domain/intel.test.ts src/features/intel/IntelView.tsx
git commit -m "feat(intel): in-process scheduler runs due tasks while the API is up (or honest relabel)"
```

---

## Self-Review
- **Spec coverage**：审计 F（TTS 坏+丢脚本 → Task 1+2；播客脚本模板 → Task 1 Step 4；intel 假自动化 → Task 3）。
- **Placeholder 风险**：Task 2 是 spike（找正确端点）——这是"未知正确形态"的合理处理：给了候选端点 + 实测脚本 + 官方文档链接 + 验收（返回真实音频），不是 TBD。
- **类型一致性**：`isIntelTaskDue(task, now)` 纯函数签名贯穿测试与调度器；`runIntelTaskOnce` 从路由抽取后两处复用同一实现。
