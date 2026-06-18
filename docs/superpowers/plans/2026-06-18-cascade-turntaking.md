# 级联语音轮转 G1–G5 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把级联语音的「频谱质心 concluding + 3.5s 兜底」轮转换成三层语义轮转(VAD → 中文语法完整度启发式 → 模糊时 LLM endpointing),并修复 preSignals 失效、决策不可审计、backchannel 写死、开场旁路状态机。

**Architecture:** 纯函数（completeness 启发式、轮转决策、backchannel 选择）+ 服务端 LLM endpoint（仅模糊时）+ 浏览器编排器（cascadedPipeline 注入 classifyEndpoint/onDecision）。回应内容仍走既有 `/turns` 角色模型。S2S 路径不动。

**Tech Stack:** TypeScript、React(Vite)、Fastify、vitest、DashScope qwen(chatClient)、CosyVoice PCM TTS。测试命令 `npx vitest run <file>`、`npx tsc -b`、`npm run typecheck:api`。

**G1 取舍说明(对 spec 的一处诚实细化):** 评审 `InteractionPreSignals` 后确认其字段是**内容信号**(`depthDirection.guidance` 等)而非时间信号。因此 `decideCascadeTurn` 保持**纯时间判定**(silence+completeness+expression),preSignals 喂给它真正的消费者——backchannel(`depthDirection.guidance`)+ 回应 prompt(已有),并**每轮刷新**(替换只读一次的快照)。这比把 preSignals 作为 no-op 参数塞进决策更诚实，G1 实质解决。

---

## 落点文件

- 新 `src/realtime/turnCompleteness.ts` + `.test.ts` — Layer 1 启发式
- 新 `src/realtime/backchannel.ts` + `.test.ts` — backchannel 选择
- 重写 `src/realtime/cascadeTurnDecision.ts` + 更新 `.test.ts` — 4 类动作
- 新 `apps/api/src/intelligence/turn-endpoint-llm.ts` + `.test.ts` — Layer 2 LLM
- 改 `apps/api/src/routes/interview-sessions.ts` — `/turn-complete` + `/decisions` 路由
- 改 `src/realtime/cascadedPipeline.ts` + `.test.ts` — 编排
- 改 `src/api/productApi.ts` — 客户端方法
- 改 `src/App.tsx` — 接线

---

## Task 1: turnCompleteness.ts（Layer 1 中文语法完整度）

**Files:**
- Create: `src/realtime/turnCompleteness.ts`
- Test: `src/realtime/turnCompleteness.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// src/realtime/turnCompleteness.test.ts
import { describe, it, expect } from "vitest";
import { assessTurnCompleteness } from "./turnCompleteness";

describe("assessTurnCompleteness", () => {
  it("空串 → incomplete", () => {
    expect(assessTurnCompleteness("")).toBe("incomplete");
    expect(assessTurnCompleteness("   ")).toBe("incomplete");
  });

  it("悬挂连词收尾 → incomplete", () => {
    expect(assessTurnCompleteness("我觉得这个方案不错，因为")).toBe("incomplete");
    expect(assessTurnCompleteness("我本来想去，但是")).toBe("incomplete");
    expect(assessTurnCompleteness("然后")).toBe("incomplete");
  });

  it("填充词收尾 → incomplete", () => {
    expect(assessTurnCompleteness("我想说的是那个")).toBe("incomplete");
    expect(assessTurnCompleteness("就是")).toBe("incomplete");
  });

  it("需要宾语的介词/连词收尾 → incomplete", () => {
    expect(assessTurnCompleteness("我把")).toBe("incomplete");
    expect(assessTurnCompleteness("苹果和")).toBe("incomplete");
    expect(assessTurnCompleteness("我现在")).toBe("incomplete"); // 在? 这里"现在"不算；见下
  });

  it("终止标点 → complete", () => {
    expect(assessTurnCompleteness("我说完了。")).toBe("complete");
    expect(assessTurnCompleteness("你说的是什么？")).toBe("complete");
    expect(assessTurnCompleteness("太好了！")).toBe("complete");
  });

  it("句末语气词收尾 → complete", () => {
    expect(assessTurnCompleteness("你觉得呢")).toBe("complete");
    expect(assessTurnCompleteness("我们今天聊控制感吧")).toBe("complete");
    expect(assessTurnCompleteness("是这样吗")).toBe("complete");
  });

  it("无明显信号的裸句 → ambiguous", () => {
    expect(assessTurnCompleteness("我昨天去了公司")).toBe("ambiguous");
    expect(assessTurnCompleteness("这件事挺复杂")).toBe("ambiguous");
  });

  it("尾随软逗号/空格不影响判定", () => {
    expect(assessTurnCompleteness("因为，")).toBe("incomplete");
    expect(assessTurnCompleteness("我说完了。 ")).toBe("complete");
  });
});
```

注：测试里 `"我现在"` 预期 incomplete 是因为「在」是需要宾语的介词之一；若实现把"现在"整体看就不会触发——为避免歧义，**实现按"最后一个字符是否属于强信号集"判定**，"现在"最后一字是"在" → incomplete。保留该用例。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/realtime/turnCompleteness.test.ts`
Expected: FAIL（`assessTurnCompleteness` 未定义）

- [ ] **Step 3: 写实现**

```ts
// src/realtime/turnCompleteness.ts
/**
 * Layer 1 of the cascade turn-taking gate: judge whether the user's transcript
 * reads as a finished thought, purely from Chinese grammar surface cues. Cheap,
 * synchronous, no model. Clear cases resolve here; "ambiguous" escalates to the
 * LLM endpoint (Layer 2). Mirrors the VAD→semantic split used by LiveKit/Pipecat.
 */
export type Completeness = "complete" | "incomplete" | "ambiguous";

// Hanging connectives — almost always followed by more clause.
const TRAILING_CONNECTIVES = [
  "因为", "所以", "但是", "可是", "不过", "然后", "而且", "并且", "比如",
  "就是说", "首先", "其次", "另外", "还有", "如果", "虽然", "由于", "为了", "以及", "于是", "接着"
];
// Discourse fillers when left dangling — speaker is buffering, not done.
const TRAILING_FILLERS = ["那个", "这个", "就是", "呃", "嗯", "怎么说", "那种", "反正", "其实", "然后呢"];
// Single chars that REQUIRE an object/complement — clearly mid-clause if final.
const TRAILING_REQUIRE_OBJECT = ["和", "跟", "与", "或", "把", "被", "对", "在", "让", "向", "给", "从", "比", "为", "把"];
// Sentence-final particles — strong "done" when at the very end.
const FINAL_PARTICLES = ["吗", "呢", "吧", "啊", "呀", "嘛", "哈", "咯", "啦"];
// Terminal punctuation — done.
const TERMINAL_PUNCT = ["。", "！", "？", "!", "?", "…"];

export function assessTurnCompleteness(transcript: string): Completeness {
  // Strip trailing soft separators / whitespace (a comma is a pause, not an end).
  const t = transcript.replace(/[，、,\s]+$/u, "").trim();
  if (!t) return "incomplete";

  // Strong "incomplete": ends on a hanging connective or filler word.
  for (const w of [...TRAILING_CONNECTIVES, ...TRAILING_FILLERS]) {
    if (t.endsWith(w)) return "incomplete";
  }
  // Strong "incomplete": last char demands a following object/complement.
  if (TRAILING_REQUIRE_OBJECT.includes(t[t.length - 1])) return "incomplete";

  // Strong "complete": terminal punctuation.
  if (TERMINAL_PUNCT.includes(t[t.length - 1])) return "complete";
  // Strong "complete": ends on a sentence-final particle.
  if (FINAL_PARTICLES.includes(t[t.length - 1])) return "complete";

  // No clear surface signal → let the LLM endpoint decide.
  return "ambiguous";
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/realtime/turnCompleteness.test.ts`
Expected: PASS（8 个用例）

- [ ] **Step 5: 提交**

```bash
git add src/realtime/turnCompleteness.ts src/realtime/turnCompleteness.test.ts
git commit -m "feat(voice): Layer 1 turn-completeness heuristic (Chinese grammar)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: backchannel.ts（上下文化 backchannel，G4）

**Files:**
- Create: `src/realtime/backchannel.ts`
- Test: `src/realtime/backchannel.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// src/realtime/backchannel.test.ts
import { describe, it, expect } from "vitest";
import { createBackchannelPicker } from "./backchannel";

describe("createBackchannelPicker", () => {
  it("circling 有 depthGuidance 时优先用它", () => {
    const pick = createBackchannelPicker();
    expect(pick("circling", "我们好像在团队授权这点上绕")).toBe("我们好像在团队授权这点上绕");
  });

  it("emotional 从共情池选，且轮换不重复", () => {
    const pick = createBackchannelPicker();
    const a = pick("emotional");
    const b = pick("emotional");
    expect(a).not.toBe(b); // 轮换
    expect(typeof a).toBe("string");
    expect(a.length).toBeGreaterThan(0);
  });

  it("无专属池的状态用默认池", () => {
    const pick = createBackchannelPicker();
    const out = pick("fluent");
    expect(out.length).toBeGreaterThan(0);
  });

  it("circling 无 guidance 时用 circling 池", () => {
    const pick = createBackchannelPicker();
    const out = pick("circling");
    expect(out.length).toBeGreaterThan(0);
    expect(out).not.toBe(""); // 来自池
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/realtime/backchannel.test.ts`
Expected: FAIL（`createBackchannelPicker` 未定义）

- [ ] **Step 3: 写实现**

```ts
// src/realtime/backchannel.ts
import type { ExpressionState } from "../domain/types";

/**
 * Picks a short backchannel utterance for the cascade. Zero-latency (no LLM):
 * rotates a small per-state pool so it doesn't repeat, and—when the LLM-generated
 * pre_signals carry a depth guidance string (the same field the S2S engine uses
 * for circling/hesitating)—prefers that contextual nudge.
 */
const POOLS: Partial<Record<ExpressionState, string[]>> = {
  circling: ["所以核心是……", "你是说……", "让我确认一下，", "听起来重点在……"],
  emotional: ["嗯，我在听。", "慢慢说。", "我理解。", "别急。"],
  hesitating: ["嗯。", "然后呢？", "你接着说。"],
};
const DEFAULT_POOL = ["嗯。", "嗯嗯。", "然后呢？"];

export function createBackchannelPicker() {
  const counters = new Map<ExpressionState, number>();
  return function pick(expressionState: ExpressionState, depthGuidance?: string): string {
    if (
      (expressionState === "circling" || expressionState === "hesitating") &&
      depthGuidance &&
      depthGuidance.trim()
    ) {
      return depthGuidance.trim();
    }
    const pool = POOLS[expressionState] ?? DEFAULT_POOL;
    const n = counters.get(expressionState) ?? 0;
    counters.set(expressionState, n + 1);
    return pool[n % pool.length];
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/realtime/backchannel.test.ts`
Expected: PASS（4 个用例）

- [ ] **Step 5: 提交**

```bash
git add src/realtime/backchannel.ts src/realtime/backchannel.test.ts
git commit -m "feat(voice): context-aware backchannel picker (G4)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: 重写 cascadeTurnDecision.ts（4 类动作）

**Files:**
- Modify (rewrite): `src/realtime/cascadeTurnDecision.ts`
- Modify: `src/realtime/cascadeTurnDecision.test.ts`

- [ ] **Step 1: 改测试（新签名 + 新分支）**

整体替换 `src/realtime/cascadeTurnDecision.test.ts` 为：

```ts
import { describe, it, expect } from "vitest";
import { decideCascadeTurn } from "./cascadeTurnDecision";

describe("decideCascadeTurn", () => {
  const base = { expressionState: "fluent" as const, silenceMs: 1000, completeness: "ambiguous" as const };

  it("静默超过 maxWait → respond（安全网）", () => {
    expect(decideCascadeTurn({ ...base, silenceMs: 9000, maxWaitMs: 8000 }).action).toBe("respond");
  });

  it("停顿过短 → wait", () => {
    expect(decideCascadeTurn({ ...base, silenceMs: 300, minPauseMs: 600 }).action).toBe("wait");
  });

  it("emotional → backchannel", () => {
    expect(decideCascadeTurn({ ...base, expressionState: "emotional" }).action).toBe("backchannel");
  });

  it("circling → backchannel", () => {
    expect(decideCascadeTurn({ ...base, expressionState: "circling" }).action).toBe("backchannel");
  });

  it("completeness=complete → respond", () => {
    expect(decideCascadeTurn({ ...base, completeness: "complete" }).action).toBe("respond");
  });

  it("completeness=incomplete → wait", () => {
    expect(decideCascadeTurn({ ...base, completeness: "incomplete" }).action).toBe("wait");
  });

  it("completeness=ambiguous → uncertain（升 Layer 2）", () => {
    expect(decideCascadeTurn({ ...base, completeness: "ambiguous" }).action).toBe("uncertain");
  });

  it("每个决策都带 reason", () => {
    expect(decideCascadeTurn(base).reason.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/realtime/cascadeTurnDecision.test.ts`
Expected: FAIL（旧实现没有 `completeness`/`uncertain`）

- [ ] **Step 3: 重写实现**

整体替换 `src/realtime/cascadeTurnDecision.ts` 为：

```ts
import type { ExpressionState } from "../domain/types";
import type { Completeness } from "./turnCompleteness";

export interface CascadeTurnInput {
  expressionState: ExpressionState;
  silenceMs: number;
  completeness: Completeness;
  maxWaitMs?: number;   // safety net only; default 8000
  minPauseMs?: number;  // below this, always wait; default 600
}
export interface CascadeTurnDecision {
  action: "respond" | "wait" | "backchannel" | "uncertain";
  reason: string;
}

/**
 * Layer 0+1 turn decision (pure, synchronous). Timing only — preSignals is a
 * CONTENT signal and is consumed by the backchannel picker + response prompt,
 * not here. "uncertain" escalates to the Layer 2 LLM endpoint.
 */
export function decideCascadeTurn(input: CascadeTurnInput): CascadeTurnDecision {
  const maxWait = input.maxWaitMs ?? 8000;
  const minPause = input.minPauseMs ?? 600;

  if (input.silenceMs >= maxWait) return { action: "respond", reason: "max-wait safety net" };
  if (input.silenceMs < minPause) return { action: "wait", reason: "pause too short" };

  // Affective states get an instant backchannel (rapport, no LLM).
  if (input.expressionState === "emotional") return { action: "backchannel", reason: "emotional → empathy" };
  if (input.expressionState === "circling") return { action: "backchannel", reason: "circling → nudge summary" };

  switch (input.completeness) {
    case "complete":   return { action: "respond", reason: "transcript reads complete" };
    case "incomplete": return { action: "wait", reason: "transcript reads incomplete (hanging)" };
    case "ambiguous":  return { action: "uncertain", reason: "ambiguous → LLM endpoint" };
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/realtime/cascadeTurnDecision.test.ts`
Expected: PASS（8 个用例）

- [ ] **Step 5: 提交**

```bash
git add src/realtime/cascadeTurnDecision.ts src/realtime/cascadeTurnDecision.test.ts
git commit -m "feat(voice): rewrite decideCascadeTurn — completeness-driven, 4 actions

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: turn-endpoint-llm.ts（Layer 2 服务端语义 endpointing）

**Files:**
- Create: `apps/api/src/intelligence/turn-endpoint-llm.ts`
- Test: `apps/api/src/intelligence/turn-endpoint-llm.test.ts`

参考既有：`BailianChatClient.complete({messages, responseFormat, maxTokens, temperature})`（[bailian.ts:311](../../apps/api/src/providers/bailian.ts)）。`InterviewSession.turns` 每项 `{role:"user"|"assistant", content}`。

- [ ] **Step 1: 写失败测试**

```ts
// apps/api/src/intelligence/turn-endpoint-llm.test.ts
import { describe, it, expect, vi } from "vitest";
import { classifyTurnComplete } from "./turn-endpoint-llm";
import type { BailianChatClient } from "../providers/bailian";
import type { InterviewSession } from "../../../src/domain/types";

function fakeSession(): InterviewSession {
  return { turns: [{ role: "user", content: "上次说到团队授权" } as any] } as InterviewSession;
}
function fakeChat(content: string): BailianChatClient {
  return { complete: vi.fn(async () => content) };
}

describe("classifyTurnComplete", () => {
  it("LLM 判 done:true → {done:true}", async () => {
    const r = await classifyTurnComplete(fakeSession(), "你说的是什么意思", fakeChat('{"done":true,"reason":"完整问句"}'));
    expect(r.done).toBe(true);
  });

  it("LLM 判 done:false → {done:false}", async () => {
    const r = await classifyTurnComplete(fakeSession(), "我觉得吧", fakeChat('{"done":false,"reason":"话没说完"}'));
    expect(r.done).toBe(false);
  });

  it("LLM 返回坏 JSON → 默认 done:true（宁可接话）", async () => {
    const r = await classifyTurnComplete(fakeSession(), "嗯", fakeChat("不是JSON"));
    expect(r.done).toBe(true);
  });

  it("chatClient 抛错 → 默认 done:true", async () => {
    const chat: BailianChatClient = { complete: vi.fn(async () => { throw new Error("timeout"); }) };
    const r = await classifyTurnComplete(fakeSession(), "嗯", chat);
    expect(r.done).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run apps/api/src/intelligence/turn-endpoint-llm.test.ts`
Expected: FAIL（未定义）

- [ ] **Step 3: 写实现**

```ts
// apps/api/src/intelligence/turn-endpoint-llm.ts
import type { BailianChatClient } from "../providers/bailian";
import type { InterviewSession } from "../../../src/domain/types";

/**
 * Layer 2 of the cascade turn gate: ask the LLM whether the user has finished
 * their turn, using the last few turns as context (LiveKit's text-first EOU idea).
 * Only called when the cheap heuristic returns "ambiguous". Fails safe to done=true
 * (respond) — better to answer than to leave the user hanging.
 */
export async function classifyTurnComplete(
  session: InterviewSession,
  transcript: string,
  chatClient: BailianChatClient
): Promise<{ done: boolean; reason: string }> {
  const recent = session.turns
    .slice(-4)
    .map((t) => `${t.role === "user" ? "用户" : "主持人"}：${t.content}`)
    .join("\n");

  const prompt =
    `你在判断访谈中"用户是否已经说完这一轮"。只判断用户最后这句是不是一个可以回应的完整表达，` +
    `还是话只说到一半（在思考、列举、卡顿、被打断）。\n\n` +
    `最近对话：\n${recent || "（无）"}\n\n` +
    `用户最新（可能未说完）：${transcript}\n\n` +
    `只输出 JSON：{"done": true 或 false, "reason": "简短中文理由"}`;

  try {
    const raw = await chatClient.complete({
      messages: [
        { role: "system", content: "你是轮转判定器，只输出 JSON，不要解释。" },
        { role: "user", content: prompt },
      ],
      responseFormat: "json",
      maxTokens: 60,
      temperature: 0,
    });
    const parsed = JSON.parse(raw) as { done?: unknown; reason?: unknown };
    return {
      done: parsed.done === true,
      reason: typeof parsed.reason === "string" ? parsed.reason : "",
    };
  } catch {
    // Parse error, timeout, or provider failure → respond (fail safe).
    return { done: true, reason: "endpoint classify failed → default respond" };
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run apps/api/src/intelligence/turn-endpoint-llm.test.ts`
Expected: PASS（4 个用例）

- [ ] **Step 5: 提交**

```bash
git add apps/api/src/intelligence/turn-endpoint-llm.ts apps/api/src/intelligence/turn-endpoint-llm.test.ts
git commit -m "feat(voice): Layer 2 LLM turn-endpoint classifier (fail-safe respond)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: 路由 /turn-complete + /decisions（接 Layer 2 + 决策日志 G3）

**Files:**
- Modify: `apps/api/src/routes/interview-sessions.ts`（加两个路由）
- Test: `apps/api/src/routes/interview-sessions.test.ts`（若不存在则 Create）

先确认既有 helper：该文件已有 `findSession`、`getSessionId`、`normalizeObject`、`normalizeOptionalString`、`options.bailianChatClient`、`repository`（见 [interview-sessions.ts:87](../../apps/api/src/routes/interview-sessions.ts)）。

- [ ] **Step 1: 写失败测试**

新增/追加到 `apps/api/src/routes/interview-sessions.test.ts`（用既有 build-server 测试夹具的同款写法；若该测试文件不存在，按下方独立用例创建，使用 fastify inject）：

```ts
import { describe, it, expect, vi } from "vitest";
import Fastify from "fastify";
import { registerInterviewSessionRoutes } from "./interview-sessions";

function buildRepo(session: any) {
  let state = { sessions: [session] };
  return {
    getState: () => state,
    replaceState: (s: any) => { state = s; },
  } as any;
}

describe("POST /turn-complete", () => {
  it("有 chatClient → 返回 LLM 判定", async () => {
    const app = Fastify();
    const session = { id: "s1", turns: [{ role: "user", content: "上次说到授权" }] };
    registerInterviewSessionRoutes(app as any, {
      repository: buildRepo(session),
      bailianChatClient: { complete: vi.fn(async () => '{"done":true,"reason":"完整"}') },
      budget: { tryConsume: () => true, reset: () => {} },
    } as any);
    const res = await app.inject({ method: "POST", url: "/api/interview-sessions/s1/turn-complete", payload: { transcript: "你说的是什么意思" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().done).toBe(true);
  });

  it("无 chatClient → 默认 done:true", async () => {
    const app = Fastify();
    const session = { id: "s1", turns: [] };
    registerInterviewSessionRoutes(app as any, { repository: buildRepo(session), budget: { tryConsume: () => true, reset: () => {} } } as any);
    const res = await app.inject({ method: "POST", url: "/api/interview-sessions/s1/turn-complete", payload: { transcript: "嗯" } });
    expect(res.json().done).toBe(true);
  });

  it("缺 transcript → 422", async () => {
    const app = Fastify();
    registerInterviewSessionRoutes(app as any, { repository: buildRepo({ id: "s1", turns: [] }), budget: { tryConsume: () => true, reset: () => {} } } as any);
    const res = await app.inject({ method: "POST", url: "/api/interview-sessions/s1/turn-complete", payload: {} });
    expect(res.statusCode).toBe(422);
  });
});

describe("POST /decisions", () => {
  it("记录决策 trace → 200", async () => {
    const app = Fastify();
    registerInterviewSessionRoutes(app as any, { repository: buildRepo({ id: "s1", turns: [] }), budget: { tryConsume: () => true, reset: () => {} } } as any);
    const res = await app.inject({ method: "POST", url: "/api/interview-sessions/s1/decisions", payload: { layer: 1, action: "respond", reason: "complete", silenceMs: 800 } });
    expect(res.statusCode).toBe(200);
  });
});
```

注：测试用的 `registerInterviewSessionRoutes` 是该文件实际导出的注册函数名——**实现 Step 3 前先 grep 确认导出名**（可能是 `registerInterviewSessionRoutes` 或默认导出），用例里的名字按实际改。budget 形如 `{ tryConsume(id):boolean, reset(id) }`（见 `/turns` 用法 [interview-sessions.ts:100](../../apps/api/src/routes/interview-sessions.ts)）。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run apps/api/src/routes/interview-sessions.test.ts`
Expected: FAIL（路由不存在 → 404）

- [ ] **Step 3: 写实现**

在 `interview-sessions.ts` 顶部加 import：

```ts
import { classifyTurnComplete } from "../intelligence/turn-endpoint-llm";
```

在 `/pre-signals` 路由之后插入两个路由（与既有路由同一注册函数体内）：

```ts
  // Layer 2 endpoint: is the user done speaking? (cascade calls this only on
  // an "ambiguous" heuristic verdict.) Fails safe to done=true (respond).
  server.post("/api/interview-sessions/:id/turn-complete", async (request, reply) => {
    const state = repository.getState();
    const session = findSession(state, getSessionId(request.params));
    if (!session) {
      return reply.code(404).send({ error: "Interview session not found." });
    }
    const transcript = normalizeOptionalString(normalizeObject<{ transcript?: unknown }>(request.body).transcript);
    if (!transcript) {
      return reply.code(422).send({ error: "transcript is required." });
    }
    if (!options.bailianChatClient) {
      return { done: true, reason: "no chat client → default respond" };
    }
    const result = await classifyTurnComplete(session, transcript, options.bailianChatClient);
    console.info(JSON.stringify({
      event: "cascade_turn_complete", sessionId: session.id,
      done: result.done, reason: result.reason, transcript: transcript.slice(0, 80)
    }));
    return result;
  });

  // Decision audit (G3): the cascade fire-and-forgets its turn decisions here so
  // they show up in the server log the operator greps. Best-effort, never errors.
  server.post("/api/interview-sessions/:id/decisions", async (request) => {
    const sessionId = getSessionId(request.params);
    const body = normalizeObject<{ layer?: unknown; action?: unknown; reason?: unknown; silenceMs?: unknown; expressionState?: unknown; transcript?: unknown }>(request.body);
    console.info(JSON.stringify({
      event: "cascade_decision", sessionId,
      layer: body.layer, action: body.action, reason: body.reason,
      silenceMs: body.silenceMs, expressionState: body.expressionState,
      transcript: typeof body.transcript === "string" ? body.transcript.slice(0, 80) : undefined
    }));
    return { ok: true };
  });
```

注：`options.bailianChatClient`、`normalizeOptionalString`、`normalizeObject`、`findSession`、`getSessionId`、`repository` 均已在该文件作用域（实现时按实际变量名核对；若注册函数把 deps 解构成局部名，照用局部名）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run apps/api/src/routes/interview-sessions.test.ts`
Expected: PASS

- [ ] **Step 5: typecheck + 提交**

Run: `npm run typecheck:api`
Expected: 无错误

```bash
git add apps/api/src/routes/interview-sessions.ts apps/api/src/routes/interview-sessions.test.ts
git commit -m "feat(voice): /turn-complete (Layer 2) + /decisions audit log routes (G3)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: cascadedPipeline.ts 编排（completeness + uncertain→classify + onDecision + 受控开场 + preSignals 刷新）

**Files:**
- Modify: `src/realtime/cascadedPipeline.ts`
- Modify: `src/realtime/cascadedPipeline.test.ts`

当前结构见 [cascadedPipeline.ts](../../src/realtime/cascadedPipeline.ts)：`handleSpeechStopped(silenceMs)` 现在直接调老 `decideCascadeTurn`（只 wait/backchannel/respond）。要改成：算 completeness → 新 decide → 处理 4 类动作（uncertain 时 await 注入的 classifyEndpoint）+ 每次 onDecision + backchannel 用 picker + 受控开场 + updatePreSignals。

- [ ] **Step 1: 加测试**

在 `src/realtime/cascadedPipeline.test.ts` 末尾（最后一个 `});` 之前不行——它是 describe 结尾，应加在 describe 内部最后一个 `it` 之后）追加用例。先在文件顶部 `makeOpts` 里允许注入 `classifyEndpoint`/`onDecision`/`assessCompleteness`（这些会在 Step 3 加进 `ConnectCascadedPipelineOptions`）。追加：

```ts
  // -------------------------------------------------------------------------
  // 8. completeness=complete（注入）→ respond
  // -------------------------------------------------------------------------
  it("completeness=complete → respond", async () => {
    asr.setExpressionState("fluent");
    const pipeline = connectCascadedPipeline(makeOpts({ assessCompleteness: () => "complete" }));
    await pipeline.startListening();
    asr.pushDelta("我昨天去了公司");
    asr.pushSpeechStopped(1000);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(sendUserTurn.fn).toHaveBeenCalledOnce();
    pipeline.close();
  });

  // 9. completeness=incomplete → wait（不回应）
  it("completeness=incomplete → wait", async () => {
    asr.setExpressionState("fluent");
    const pipeline = connectCascadedPipeline(makeOpts({ assessCompleteness: () => "incomplete" }));
    await pipeline.startListening();
    asr.pushDelta("我觉得吧，因为");
    asr.pushSpeechStopped(1000);
    await Promise.resolve(); await Promise.resolve();
    expect(sendUserTurn.fn).not.toHaveBeenCalled();
    pipeline.close();
  });

  // 10. ambiguous + classifyEndpoint done:true → respond
  it("ambiguous + classifyEndpoint done:true → respond", async () => {
    asr.setExpressionState("fluent");
    const classifyEndpoint = vi.fn(async () => ({ done: true, reason: "ok" }));
    const pipeline = connectCascadedPipeline(makeOpts({ assessCompleteness: () => "ambiguous", classifyEndpoint }));
    await pipeline.startListening();
    asr.pushDelta("这件事挺复杂");
    asr.pushSpeechStopped(1000);
    await vi.waitFor(() => expect(classifyEndpoint).toHaveBeenCalled());
    await Promise.resolve(); await Promise.resolve();
    expect(sendUserTurn.fn).toHaveBeenCalledOnce();
    pipeline.close();
  });

  // 11. ambiguous + classifyEndpoint done:false → wait
  it("ambiguous + classifyEndpoint done:false → wait", async () => {
    asr.setExpressionState("fluent");
    const classifyEndpoint = vi.fn(async () => ({ done: false, reason: "not done" }));
    const pipeline = connectCascadedPipeline(makeOpts({ assessCompleteness: () => "ambiguous", classifyEndpoint }));
    await pipeline.startListening();
    asr.pushDelta("这件事挺复杂");
    asr.pushSpeechStopped(1000);
    await vi.waitFor(() => expect(classifyEndpoint).toHaveBeenCalled());
    await Promise.resolve(); await Promise.resolve();
    expect(sendUserTurn.fn).not.toHaveBeenCalled();
    pipeline.close();
  });

  // 12. classifyEndpoint 抛错 → 兜底 respond
  it("classifyEndpoint 抛错 → 兜底 respond", async () => {
    asr.setExpressionState("fluent");
    const classifyEndpoint = vi.fn(async () => { throw new Error("net"); });
    const pipeline = connectCascadedPipeline(makeOpts({ assessCompleteness: () => "ambiguous", classifyEndpoint }));
    await pipeline.startListening();
    asr.pushDelta("这件事挺复杂");
    asr.pushSpeechStopped(1000);
    await vi.waitFor(() => expect(classifyEndpoint).toHaveBeenCalled());
    await Promise.resolve(); await Promise.resolve();
    expect(sendUserTurn.fn).toHaveBeenCalledOnce();
    pipeline.close();
  });

  // 13. onDecision 被调用并带 trace
  it("onDecision 收到决策 trace", async () => {
    asr.setExpressionState("fluent");
    const traces: any[] = [];
    const pipeline = connectCascadedPipeline(makeOpts({ assessCompleteness: () => "complete", onDecision: (t) => traces.push(t) }));
    await pipeline.startListening();
    asr.pushDelta("我昨天去了公司");
    asr.pushSpeechStopped(1000);
    await Promise.resolve(); await Promise.resolve();
    expect(traces.length).toBeGreaterThan(0);
    expect(traces[0]).toHaveProperty("action");
    expect(traces[0]).toHaveProperty("reason");
    pipeline.close();
  });

  // 14. 受控开场 → 进 speaking 态并播开场词
  it("startListening(opening) 受控开场进 speaking", async () => {
    asr.setExpressionState("fluent");
    const pipeline = connectCascadedPipeline(makeOpts());
    await pipeline.startListening("上次你说要追的那个问题，现在怎么样了？");
    expect(stateChanges).toContain("speaking");
    expect(tts.segments.flat().join("")).toContain("上次你说要追的那个问题");
    pipeline.close();
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/realtime/cascadedPipeline.test.ts`
Expected: FAIL（新选项/受控开场未实现）

- [ ] **Step 3: 改实现**

3a. 在 `ConnectCascadedPipelineOptions` 接口加字段、import：

```ts
import type { ExpressionState, InteractionPreSignals } from "../domain/types";
import { decideCascadeTurn } from "./cascadeTurnDecision";
import { assessTurnCompleteness, type Completeness } from "./turnCompleteness";
import { createBackchannelPicker } from "./backchannel";

export interface DecisionTrace {
  layer: 0 | 1 | 2;
  action: string;
  reason: string;
  transcript: string;
  silenceMs: number;
  expressionState: ExpressionState;
}
```

在 `ConnectCascadedPipelineOptions` 内追加：

```ts
  classifyEndpoint?: (transcript: string, signal: AbortSignal) => Promise<{ done: boolean; reason?: string }>;
  onDecision?: (trace: DecisionTrace) => void;
  assessCompleteness?: (transcript: string) => Completeness;
```

3b. 在 `connectCascadedPipeline` 解构 + 状态区加：

```ts
  const {
    asr, tts, sendUserTurn, callbacks, preSignals = null, decisionOpts = {},
    classifyEndpoint, onDecision, assessCompleteness = assessTurnCompleteness,
  } = opts;
  const { minPauseMs = 600, maxWaitMs = 8000 } = decisionOpts;

  const pickBackchannel = createBackchannelPicker();
  let currentPreSignals: InteractionPreSignals | null = preSignals;
  let classifyAbort: AbortController | null = null;
```

（注意 `maxWaitMs` 默认从 3500 改 8000。）

3c. 整体替换 `handleSpeechStopped`：

```ts
  async function handleSpeechStopped(silenceMs: number) {
    if (closed) return;
    if (micSuppressed) return;
    if (state === "thinking" || state === "speaking") return;

    const transcript = (committedTranscript + partialTranscript).trim();
    const expressionState = asr.getExpressionState();
    const completeness = assessCompleteness(transcript);
    const decision = decideCascadeTurn({ expressionState, silenceMs, completeness, minPauseMs, maxWaitMs });

    onDecision?.({ layer: completeness === "ambiguous" ? 1 : (decision.action === "respond" && silenceMs >= maxWaitMs ? 0 : 1),
      action: decision.action, reason: decision.reason, transcript, silenceMs, expressionState });

    if (decision.action === "wait") {
      if (maxWaitTimer === null) {
        maxWaitTimer = setTimeout(() => {
          maxWaitTimer = null;
          if (!closed && state !== "thinking" && state !== "speaking") void doRespond();
        }, maxWaitMs);
      }
      return;
    }

    if (decision.action === "backchannel") {
      clearMaxWaitTimer();
      const text = pickBackchannel(expressionState, currentPreSignals?.depthDirection?.guidance);
      suppressMic();
      try { await tts.speak([text]); } catch { /* stopped */ }
      releaseMicAfterGuard();
      return;
    }

    if (decision.action === "uncertain") {
      clearMaxWaitTimer();
      if (!classifyEndpoint) {
        // No Layer 2 available → fall back to the silence safety net (wait).
        if (maxWaitTimer === null) {
          maxWaitTimer = setTimeout(() => {
            maxWaitTimer = null;
            if (!closed && state !== "thinking" && state !== "speaking") void doRespond();
          }, maxWaitMs);
        }
        return;
      }
      classifyAbort?.abort();
      classifyAbort = new AbortController();
      const sig = classifyAbort.signal;
      let done = true; // fail safe
      try {
        const r = await classifyEndpoint(transcript, sig);
        if (sig.aborted || closed) return; // superseded by barge-in
        done = r.done;
        onDecision?.({ layer: 2, action: done ? "respond" : "wait", reason: r.reason ?? "llm endpoint", transcript, silenceMs, expressionState });
      } catch {
        if (sig.aborted || closed) return;
        done = true; // classify failed → respond
      } finally {
        if (classifyAbort?.signal === sig) classifyAbort = null;
      }
      if (done) { await doRespond(); }
      else if (maxWaitTimer === null) {
        maxWaitTimer = setTimeout(() => {
          maxWaitTimer = null;
          if (!closed && state !== "thinking" && state !== "speaking") void doRespond();
        }, maxWaitMs);
      }
      return;
    }

    // action === "respond"
    clearMaxWaitTimer();
    await doRespond();
  }
```

3d. 在 `handleSpeechStarted`（barge-in）里，停 TTS 后**取消进行中的 classify**——在 `tts.stop();` 之后加：

```ts
      classifyAbort?.abort();
      classifyAbort = null;
```

3e. 受控开场 + updatePreSignals：把 `startListening` 改为接受可选开场词，并加 `updatePreSignals`。整体替换 return 的对象：

```ts
  return {
    async startListening(openingText?: string) {
      setState("listening");
      if (openingText && openingText.trim()) {
        setState("speaking");
        suppressMic();
        try { await tts.speak([openingText.trim()]); } catch { /* stopped */ }
        releaseMicAfterGuard();
        if (!closed) setState("listening");
      }
      await asr.start();
    },

    updatePreSignals(next: InteractionPreSignals | null) {
      currentPreSignals = next;
    },

    interrupt() {
      if (activeAbort) { activeAbort.abort(); activeAbort = null; }
      classifyAbort?.abort(); classifyAbort = null;
      tts.stop();
      clearMaxWaitTimer();
      setState("interrupted");
    },

    close() {
      closed = true;
      clearMaxWaitTimer();
      if (echoGuardTimer !== null) { clearTimeout(echoGuardTimer); echoGuardTimer = null; }
      micSuppressed = false;
      classifyAbort?.abort(); classifyAbort = null;
      if (activeAbort) { activeAbort.abort(); activeAbort = null; }
      tts.stop();
      asr.stop();
    },
  };
```

3f. 更新 `CascadedPipeline` 接口签名：

```ts
export interface CascadedPipeline {
  startListening(openingText?: string): Promise<void>;
  updatePreSignals(next: InteractionPreSignals | null): void;
  interrupt(): void;
  close(): void;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/realtime/cascadedPipeline.test.ts`
Expected: PASS（原 9 + 新 7 = 16）

- [ ] **Step 5: typecheck + 提交**

Run: `npx tsc -b`
Expected: 0 错误

```bash
git add src/realtime/cascadedPipeline.ts src/realtime/cascadedPipeline.test.ts
git commit -m "feat(voice): cascade pipeline — semantic gate orchestration + controlled opening (G2/G5)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: App.tsx 接线 + productApiClient（classifyEndpoint / onDecision / 刷新 preSignals / 开场进 pipeline）

**Files:**
- Modify: `src/api/productApi.ts`（加 `classifyTurnComplete` + `logCascadeDecision`）
- Modify: `src/App.tsx`（cascade 分支接线）

- [ ] **Step 1: 加 productApiClient 方法 + 类型**

在 `productApi.ts` 的客户端接口与实现里加（紧邻既有 `recordInterviewTurn`）：

接口声明处：
```ts
  classifyTurnComplete(sessionId: string, transcript: string): Promise<{ done: boolean; reason: string }>;
  logCascadeDecision(sessionId: string, trace: { layer: number; action: string; reason: string; silenceMs: number; expressionState: string; transcript: string }): Promise<void>;
```

实现处（仿照既有 fetch 写法、同 baseUrl）：
```ts
    async classifyTurnComplete(sessionId, transcript) {
      const res = await fetch(`${baseUrl}/api/interview-sessions/${sessionId}/turn-complete`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ transcript })
      });
      if (!res.ok) return { done: true, reason: "http error → respond" };
      return res.json();
    },
    async logCascadeDecision(sessionId, trace) {
      try {
        await fetch(`${baseUrl}/api/interview-sessions/${sessionId}/decisions`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify(trace)
        });
      } catch { /* best-effort audit */ }
    },
```

- [ ] **Step 2: 接线 cascade 分支**

在 `src/App.tsx` cascade 分支（`connectCascadedPipeline({...})` 调用处）：

2a. 给 `connectCascadedPipeline` 增加三个选项（在 `callbacks` 同级）：
```ts
              classifyEndpoint: interviewId
                ? (text: string, _signal: AbortSignal) => productApiClient.classifyTurnComplete(interviewId, text)
                : undefined,
              onDecision: (trace) => {
                // G3: devtools + server log (the service log the operator greps).
                console.debug("[cascade decision]", trace);
                if (interviewId) void productApiClient.logCascadeDecision(interviewId, trace);
              },
```

2b. `sendUserTurn` 里在拿到 `/turns` 返回后刷新 preSignals（G1）。把现有：
```ts
              const r = await productApiClient.sendInterviewTurn(interviewId, { content: text });
              setSession(r.session);
              setProductState(r.state);
              setApiPersistenceEnabled(true);
              const assistantText = r.session.turns.at(-1)?.content ?? "";
              return { assistantText };
```
改为（追加刷新）：
```ts
              const r = await productApiClient.sendInterviewTurn(interviewId, { content: text });
              setSession(r.session);
              setProductState(r.state);
              setApiPersistenceEnabled(true);
              if (r.preSignals) cascadePipelineRef.current?.updatePreSignals(r.preSignals);
              const assistantText = r.session.turns.at(-1)?.content ?? "";
              return { assistantText };
```

2c. 开场进状态机（G5）。把现有：
```ts
            if (card.suggestedOpening) {
              await tts.speak([card.suggestedOpening]);
            }
            await pipeline.startListening();
```
改为：
```ts
            await pipeline.startListening(card.suggestedOpening || undefined);
```

注：`/turns` 响应里 `preSignals` 字段已存在（[interview-sessions.ts:109](../../apps/api/src/routes/interview-sessions.ts)），但前端 `SendInterviewTurnResponse`/`InterviewSessionResponse` 类型可能未含该字段——若 tsc 报错，给该响应类型加可选 `preSignals?: InteractionPreSignals`（从 `domain/types` import）。

- [ ] **Step 3: typecheck**

Run: `npx tsc -b`
Expected: 0 错误（如有 preSignals 类型缺失，按 Step 2 注补类型）

- [ ] **Step 4: 提交**

```bash
git add src/api/productApi.ts src/App.tsx
git commit -m "feat(voice): wire cascade semantic gate into App — classify/decisions/preSignals/opening (G1/G3/G5)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: 全量回归 + 真链路验证 + 收尾

**Files:** 无（验证 + 文档）

- [ ] **Step 1: 全量单测**

Run: `npx vitest run`
Expected: 全绿（原有 + 新增 turnCompleteness/backchannel/cascadeTurnDecision/turn-endpoint-llm/路由/pipeline 用例）

- [ ] **Step 2: 类型**

Run: `npx tsc -b && npm run typecheck:api`
Expected: 0 错误

- [ ] **Step 3: 重启服务 + 真链路冒烟（turn-complete 端点）**

```bash
pkill -9 -f "dev-full.mjs" 2>/dev/null; lsof -ti:5173 | xargs kill -9 2>/dev/null; lsof -ti:8787 | xargs kill -9 2>/dev/null; sleep 2
nohup npm run dev:full > /tmp/zhuanfang-service.log 2>&1 &
sleep 13 && curl -s -m5 http://127.0.0.1:8787/api/health
```
然后对一个已有 session 调 `/turn-complete`（用 `/api/state` 取一个 session id），确认返回 `{done, reason}` 且 service log 出现 `cascade_turn_complete` 结构化行。

- [ ] **Step 4: 决策日志可审计性验证**

调 `/decisions` 一次，`grep cascade_decision /tmp/zhuanfang-service.log` 应见结构化行——确认 G3「审查日志」闭环。

- [ ] **Step 5: 提交收尾（如有验证脚本/文档微调）**

```bash
git add -A spike-*.mjs 2>/dev/null; git status
# 仅提交本计划相关文件，勿 git add -A 整个仓库
```

---

## Self-Review（计划 vs spec）

- **G1 preSignals 生效**：Task 6（pickBackchannel 用 `depthDirection.guidance`）+ Task 7（每轮 `updatePreSignals`）✅
- **G2 语义轮转**：Task 1（completeness）+ Task 3（decide 4 动作）+ Task 4/5（LLM endpoint）+ Task 6（编排 uncertain→classify、maxWait 放宽 8s）✅
- **G3 可审计**：Task 5（`/decisions` + `/turn-complete` 服务端结构化日志）+ Task 7（onDecision→console+POST）✅
- **G4 backchannel**：Task 2（picker）+ Task 6（接入）✅
- **G5 开场进状态机**：Task 6（`startListening(openingText)`）+ Task 7（App 调用）✅
- **错误降级**：Task 4（坏 JSON/抛错→done:true）、Task 6（classify 抛错/超时→respond；无 endpoint→兜底 wait）✅
- **测试**：每个纯函数 + 服务端 mock + pipeline 注入式 + 全量回归 ✅
- 占位符扫描：无 TBD/TODO；每步含真实代码与命令 ✅
- 类型一致性：`Completeness`(Task1)被 Task3/6 引用一致；`decideCascadeTurn` 新签名(Task3)被 Task6 调用一致；`classifyEndpoint`/`onDecision`/`assessCompleteness`/`updatePreSignals`(Task6 定义)被 Task7 调用一致；`classifyTurnComplete`(Task4)被 Task5 调用一致 ✅
- 已知实现期需 grep 核对项（已在对应 Task 标注）：interview-sessions 的注册函数导出名、budget 形状、前端 `preSignals` 响应类型字段。
