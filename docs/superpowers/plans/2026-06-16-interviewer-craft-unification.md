# 专访"提问质感"统一与语音开场修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把"专访主持人"的人设 + 追问技法 + 会前跟踪点上下文收敛成**一份共享真源**，让文字/语音/LiveKit 三条路用同一套质感；并修掉语音"上来先问你过得怎么样"的不自然开场（强制从跟踪点续接、禁寒暄/元话语）。

**Architecture:** 现状是同一套人设散落在 **5 处并各自漂移**（文字版最全、语音浏览器版最瘦、LiveKit Python 版还硬塞了一句"向用户问好"）。方案：抽出一份共享 `INTERVIEWER_CRAFT`（人设+张小珺式追问铁律），文字 prompt 与语音 prompt 都基于它；语音版额外加"开场铁律"（强制 `suggestedOpening` 续接、禁寒暄/元话语）并注入和文字版同样的 guide 跟踪点；删掉 App.tsx 的瘦副本；LiveKit agent 改为从 API 取统一指令并去掉硬编码问候；开场再做"显式脚本化"双保险。

**Tech Stack:** TypeScript, Vitest, Fastify, React, DashScope Realtime(WebSocket/WebRTC), LiveKit + Python agent。

---

## 背景与深度分析

详尽的范本分析见 [2026-06-16-interview-craft-zhangxiaojun.md](2026-06-16-interview-craft-zhangxiaojun.md)。两个已证实的结论：

1. **跟踪点策略没丢**：`buildInterviewGuide`（`src/domain/context-pack.ts:449`）仍在算全套——反复主题(topTheme)、未还知识债(openDebts)、"上次要求继续的问题"(focusQuestion)、记忆召回(relevantMemories)、过去立场(statedPositions)、观点演变(opinionEvolution)、盲区(blindspotCandidates)、全网素材(searchBrief/sourceHighlights)。`openingQuestion`(:473–481) 本身就是"从跟踪点续接"。**文字路径 `buildCharacterSystemPrompt` 把它们全用上了。**

2. **语音不自然的真因**：浏览器语音用的是 `src/App.tsx:1344` 的**瘦副本**（6 行，只发 title/whyNow/suggestedOpening，丢掉全部跟踪点），且**没有强制开场**——WS 连上即 `response.create`（`bailianWebsocket.ts:266`）让 AI 先说话，模型没有"第一步该干嘛"的指令 → 退回通用寒暄"你过得怎么样" + 元话语填空"刚来没来得及"。LiveKit 路径则更直接：`agent/main.py:75` 硬编码 `generate_reply("向用户问好…邀请他开始提问")`。

---

## 爆炸半径（必须同步的清单 + 会断的测试）

### A. 人设/指令"真源"分布在 5 处（会漂移的根因）
| # | 位置 | 现状 | 处置 |
|---|---|---|---|
| 1 | `apps/api/src/providers/bailian.ts:790-853` `buildCharacterSystemPrompt` | 文字路径，最全（已有引用历史/抓矛盾/盲区/16 动作库/抽象→具体） | 改为复用共享 `INTERVIEWER_CRAFT`，补齐缺的张小珺技法 |
| 2 | `src/domain/voice-instructions.ts:6-41` `buildRealtimeVoiceInstructions` | 语音"规范版"，较全；**被 `turn-builder.ts:306`（LiveKit agent-context）使用**，但**不被浏览器语音使用** | 升级为语音真源：共享 craft + 开场铁律 + 全套 guide 注入 |
| 3 | `src/App.tsx:1344-1353` `buildRealtimeVoiceInstructions`（本地瘦副本） | **浏览器 WS/WebRTC 实际用的就是它**（`App.tsx:940`） | **删除**，改 import 域版本(#2) |
| 4 | `apps/api/src/routes/realtime-voice.ts:478-482` `normalizeInstructions` 兜底串 | 无传入指令时的默认 | 升级为含开场铁律的合理默认 |
| 5 | `agent/main.py:43-50`（静态 persona）+ `main.py:74-76`（"向用户问好"开场） | LiveKit Python agent 自带一套 + 硬编码问候 | persona 精简、改为依赖 agent-context 拉取的统一指令；**删掉硬编码问候**，开场改用 `suggestedOpening` |

> `zhuanfang/**` 下有重复副本（陈旧拷贝，见记忆 [[zhuanfang-make-real-effort]]）——**本方案不动 zhuanfang/**。

### B. 会断的测试（改 prompt 必同步）
- `apps/api/src/providers/bailian.test.ts:294-295` — 断言文字 prompt `toContain("真正的专访主持人")` + `toContain("<pre_signals>")`。
- `src/domain/interviewSession.test.ts:31` — 断言 agent-context `instructions` 含 `"你是一个真正的私人专访主持人"`；`:142-146` — 空 card/guide 安全（renderToString 式不崩）。
- `apps/api/src/routes/realtime-voice.test.ts:212` — `body.instructions` 含人设串。
- `apps/api/src/server.test.ts:801,818` / `src/realtime/bailianWebsocket.test.ts:33` / `bailianWebrtc.test.ts:141` / `src/api/productApi.test.ts:394/408/416` / `tests/e2e/interview-api.spec.ts:110` — 这些是 **mock 输入**（fixture），只要不断言真实输出就不会断；但凡断言人设串的（如 server.test 若有 toContain）要核对。

### C. 数据可用性（已确认）
`session.guide` 与 `session.card.suggestedOpening/whyNow` 在 `toggleRealtimeRecording`（语音启动）时**已就位**——瘦副本是主动丢弃，不是没有。

---

## 架构决策

**一份共享真源 `INTERVIEWER_CRAFT`，三条路复用；输出格式各自不同。**
- 共享核（人设 + 追问铁律 + 跟踪点注入约定）。
- 文字 = 共享核 + 文字输出要求 + `<pre_signals>` 模板。
- 语音 = 共享核 + **开场铁律** + 语音节奏（短/留白/可打断）+ 不带 pre_signals（语音 pre_signals 走 `/pre-signals` 端点）。
- LiveKit = 取 API 的语音指令（agent-context）+ 显式脚本化开场，去掉自带 persona/问候。
- **开场双保险**：①prompt 层强制 `suggestedOpening`+禁寒暄；②首轮触发层显式把开场词喂给模型（WS 的 `response.create` 带 `instructions`，LiveKit 的 `generate_reply` 用 `suggestedOpening`）。

---

## File Structure

- **Create** `src/domain/interviewer-craft.ts` — 导出 `INTERVIEWER_CRAFT_RULES`（共享追问铁律常量）+ `buildVoiceOpeningDiscipline(card)`（开场铁律块）。单一职责：质感规则的唯一真源。
- **Modify** `src/domain/voice-instructions.ts` — 语音 prompt 复用共享核 + 开场铁律 + 全 guide 注入。
- **Modify** `src/App.tsx` — 删本地瘦 `buildRealtimeVoiceInstructions`，import 域版本。
- **Modify** `apps/api/src/providers/bailian.ts` — 文字 prompt 复用共享核。
- **Modify** `apps/api/src/routes/realtime-voice.ts` — `normalizeInstructions` 兜底升级。
- **Modify** `src/realtime/bailianWebsocket.ts` — 首轮 `response.create` 带显式开场指令。
- **Modify** `agent/main.py` — 去硬编码问候、persona 精简、开场用 `suggestedOpening`。
- **Modify** tests（见爆炸半径 B）。
- **Create** `apps/api/src/e2e/voice-opening.real.test.ts` — 真 LLM gated：断言开场是跟踪点续接、无寒暄。

---

## Tasks

### Task 1: 抽出共享 `INTERVIEWER_CRAFT_RULES`（含补齐的张小珺技法）

**Files:**
- Create: `src/domain/interviewer-craft.ts`
- Test: `src/domain/interviewer-craft.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// src/domain/interviewer-craft.test.ts
import { describe, expect, it } from "vitest";
import { INTERVIEWER_CRAFT_RULES, buildVoiceOpeningDiscipline } from "./interviewer-craft";
import type { InterviewCard } from "./types";

describe("interviewer craft", () => {
  it("craft rules cover the张小珺 techniques", () => {
    const t = INTERVIEWER_CRAFT_RULES;
    expect(t).toContain("每次只问一个核心问题");
    expect(t).toContain("具体");          // 钉具体事例
    expect(t).toContain("二选一");        // 二选一框架
    expect(t).toContain("矛盾");          // 抓矛盾
    expect(t).toContain("很难说");        // 不许用"很难说"收尾
    expect(t).toMatch(/总结|小结/);      // 总结打点
  });
  it("opening discipline forbids small-talk and scripts the suggestedOpening", () => {
    const card = { suggestedOpening: "如果你允许短期失控，最坏会发生什么？" } as InterviewCard;
    const d = buildVoiceOpeningDiscipline(card);
    expect(d).toContain("如果你允许短期失控");      // 注入了开场问题
    expect(d).toContain("不寒暄");
    expect(d).toMatch(/你好吗|最近怎么样|刚来/);   // 显式点名禁止的寒暄/元话语
    expect(d).toMatch(/跟踪点|续接|接着/);         // 强调"续接"而非"自我介绍"
  });
});
```

- [ ] **Step 2: 运行确认失败** — `npx vitest run src/domain/interviewer-craft.test.ts` → FAIL（模块不存在）。

- [ ] **Step 3: 实现**

```ts
// src/domain/interviewer-craft.ts
import type { InterviewCard } from "./types";

/** 文字 + 语音共用的"主持人质感"铁律（张小珺式追问技法）。改这里 = 改全部路径。 */
export const INTERVIEWER_CRAFT_RULES = [
  "你是一个真正的专访主持人，不是普通聊天助手，也不是客服。",
  "目标：用自然、克制、有人味的追问，把模糊表达推进到具体事件、真实张力、可验证问题和可沉淀资产。",
  "",
  "追问铁律（每次开口都遵守）：",
  "- 每次只问一个核心问题；不要长篇，不要替对方下结论。",
  "- 对方用抽象/含糊词（'没办法''还好''差不多''很难说'）时，先把它钉成一个具体时刻：谁、何时、哪一句话、哪个场景。",
  "- 对方给概括性回答时，下一句必须要具体：'最近一次是什么时候？能举个例子吗？'",
  "- 对方想'两者都有/都不是'时，给一个二选一框架逼他选边，或让他反驳这个框架本身。",
  "- 抓矛盾：对方现在说的和他过去的立场/刚才的话有张力时，温和但明确地指出来追问。",
  "- 引用历史：自然相关时，引用一条历史原话来追问或指出前后变化，不要生硬套用。",
  "- 回访知识债 / 戳盲区：合适时把对话引向未还的知识债或对方在回避的盲区。",
  "- 不允许对话停在'很难说/说不定'——立刻用二选一或一个具体条件把它接下去。",
  "- 阶段小结：用一句话替对方总结（'所以你其实是…，对吗？'），让他确认或纠正。"
].join("\n");

/** 语音专属的"开场铁律"：把会前算好的跟踪点续接成第一句，杜绝寒暄/元话语。 */
export function buildVoiceOpeningDiscipline(card: Pick<InterviewCard, "suggestedOpening">): string {
  return [
    "【开场铁律 · 最重要】",
    "- 你已经做足功课。这是对同一个人的持续跟踪，不是初次见面——绝不寒暄、绝不自我介绍、绝不说'你好吗/最近怎么样/我刚来/没准备好/让我想想'。",
    "- 第一句话直接从一个'跟踪点'切入：先用一句话点出'接着你之前/反复在追的什么'，紧接着抛出开场问题。",
    `- 开场问题（口语化后直接问，别照念）：${card.suggestedOpening}`,
    "- 跟踪点来源（择一自然带出）：上次明确要求继续的问题 / 反复出现的长期主题 / 未还的知识债 / 全网素材里与你主题相关的新进展。"
  ].join("\n");
}
```

- [ ] **Step 4: 运行通过** — `npx vitest run src/domain/interviewer-craft.test.ts` → PASS。

- [ ] **Step 5: Commit** — `git add src/domain/interviewer-craft.ts src/domain/interviewer-craft.test.ts && git commit -m "feat(interview): shared INTERVIEWER_CRAFT rules + voice opening discipline (张小珺式追问技法单一真源)"`

---

### Task 2: 语音 prompt 升级为真源（共享核 + 开场铁律 + 全 guide 注入）

**Files:**
- Modify: `src/domain/voice-instructions.ts:6-41`
- Test: `src/domain/voice-instructions.test.ts`（新建或并入 interviewer-craft.test）

- [ ] **Step 1: 写失败测试**

```ts
// src/domain/voice-instructions.test.ts
import { describe, expect, it } from "vitest";
import { buildRealtimeVoiceInstructions } from "./voice-instructions";
import { createDemoProductState } from "./engine";          // 用 demo 拿到非空 guide/card
import { createSessionDraft } from "./engine";

describe("voice instructions", () => {
  it("includes opening discipline, craft rules, and the guide tracking-points", () => {
    const state = createDemoProductState();
    const session = createSessionDraft(state, "decision", "standard", {});
    const out = buildRealtimeVoiceInstructions(session, session.card);
    // 开场铁律
    expect(out).toContain("【开场铁律");
    expect(out).toMatch(/你好吗|最近怎么样|刚来/);   // 显式禁止寒暄/元话语
    expect(out).toContain(session.card.suggestedOpening);
    // 追问铁律（共享核）
    expect(out).toContain("每次只问一个核心问题");
    expect(out).toContain("二选一");
    // 跟踪点注入（瘦副本曾全丢）
    expect(out).toMatch(/历史|立场|知识债|盲区/);
  });
  it("does not crash on an empty (clean-start) session", () => {
    const empty = createSessionDraft(createEmptyProductStateLike(), "decision", "standard", {});
    expect(() => buildRealtimeVoiceInstructions(empty, empty.card)).not.toThrow();
  });
});
```
> 注：第二个用例需要一个空 state 的 session；用 `createEmptyProductState()`（已存在）构造，命名按实际导入调整。保留 `interviewSession.test.ts:142` 的空安全断言不破。

- [ ] **Step 2: 运行确认失败** — 现版本无开场铁律、无"二选一" → FAIL。

- [ ] **Step 3: 实现** —— 重写 `buildRealtimeVoiceInstructions`：

```ts
import { INTERVIEWER_CRAFT_RULES, buildVoiceOpeningDiscipline } from "./interviewer-craft";
// ... 既有的 guide/card 解构（historyReferences/relevantMemories/openDebts/blindspot/perspectives/sourceHighlights 等）保留 ...
export function buildRealtimeVoiceInstructions(session: InterviewSession | null, fallbackCard?: InterviewCard) {
  const card = session?.card ?? fallbackCard;
  const guide = session?.guide;
  return [
    card ? buildVoiceOpeningDiscipline(card) : "",
    "",
    INTERVIEWER_CRAFT_RULES,
    "",
    "【语音节奏】允许短反馈；用户一打断立刻停、把控制权还给用户；沉默时先留白，不要急着填满。不长篇、不替对方下结论、不像客服。",
    "",
    `本次主题：${session?.title ?? card?.title ?? "未命名专访"}`,
    card?.whyNow ? `为什么现在聊：${card.whyNow}` : "",
    // —— 跟踪点（和文字路径同源；瘦副本曾全部丢弃）——
    guide?.debtToAddress ? `待追问知识债：${guide.debtToAddress}。${guide.openDebts[0]?.nextQuestion ?? ""}` : "",
    guide?.blindspotCandidates?.[0] ? `盲区候选：${guide.blindspotCandidates[0].concept}。${guide.blindspotCandidates[0].reason}` : "",
    (guide?.relevantMemories ?? []).length ? `可引用记忆/历史：${guide!.relevantMemories.slice(0,3).join("；")}` : "",
    (guide?.statedPositions ?? []).length ? `用户过去的立场（出现矛盾就温和点出）：${guide!.statedPositions.slice(0,3).join("；")}` : "",
    (card?.historyReferences ?? []).length ? `历史原话：${card!.historyReferences.slice(0,3).join("；")}` : "",
    (card?.sourceHighlights ?? []).length ? `全网素材：${card!.sourceHighlights.slice(0,2).map(s => `${s.title}｜${s.snippet}`).join("；")}` : "",
    guide?.recommendedPerspectives?.length ? `建议视角（以一个自然问题呈现，别讲理论课）：${guide.recommendedPerspectives.slice(0,3).join("、")}` : ""
  ].filter(Boolean).join("\n");
}
```
（保留原有 `?.` 空安全；字段名以 `InterviewGuide`/`InterviewCard` 类型为准，逐一核对。）

- [ ] **Step 4: 运行通过** + 跑 `src/domain/interviewSession.test.ts`（空安全 + agent-context 断言）确认不破。

- [ ] **Step 5: Commit** — `git commit -m "feat(voice): rebuild realtime voice prompt — opening discipline + shared craft + full guide tracking-points"`

---

### Task 3: 删 App.tsx 瘦副本，浏览器语音改用域版本

**Files:** Modify: `src/App.tsx`（删 1344-1353 的本地函数；`:940` 改为调用 import 的域版本；确认顶部已 `import { buildRealtimeVoiceInstructions } from "./domain/engine"` 或 `./domain/voice-instructions`）。

- [ ] **Step 1**: 删除 `src/App.tsx:1344-1353` 的本地 `buildRealtimeVoiceInstructions`。
- [ ] **Step 2**: 在 import 区加入 `buildRealtimeVoiceInstructions`（来自 `./domain/engine`，已 re-export）。`:940` 调用签名保持 `(session, card)`。
- [ ] **Step 3**: `npx tsc -b` → 0；起 dev 在浏览器实测（Task 8）。
- [ ] **Step 4: Commit** — `git commit -m "refactor(voice): browser realtime voice uses the unified domain prompt (drop App.tsx thin copy)"`

---

### Task 4: 文字 prompt 复用共享核（文字也补齐张小珺技法）

**Files:** Modify: `apps/api/src/providers/bailian.ts:790-853`；Test: `apps/api/src/providers/bailian.test.ts:294`。

- [ ] **Step 1: 改测试**（先让它表达新意图）——在 `bailian.test.ts` 既有断言旁追加：`expect(content).toContain("二选一"); expect(content).toContain("很难说");`，保留 `toContain("<pre_signals>")` 与一个稳定人设断言（把 `toContain("真正的专访主持人")` 收敛为 `toContain("专访主持人")` 以兼容共享核措辞）。
- [ ] **Step 2: 运行确认失败**。
- [ ] **Step 3: 实现** —— `buildCharacterSystemPrompt` 开头改为引入 `INTERVIEWER_CRAFT_RULES`（替换原来手写的人设+部分语言要求），保留：guide 注入块（已很好）、16 动作库、"输出只返回主持人下一句中文追问"、`<pre_signals>` 模板。即"共享核 + 文字专属输出层"。
- [ ] **Step 4: 运行通过** + 全量 `npx vitest run` 绿。
- [ ] **Step 5: Commit** — `git commit -m "refactor(interview): text prompt reuses shared craft rules (parity with voice)"`

---

### Task 5: 语音开场"显式脚本化"（WS 首轮带开场指令）

**Files:** Modify: `src/realtime/bailianWebsocket.ts`（首轮 `response.create`）；Test: `src/realtime/bailianWebsocket.test.ts`。

- [ ] **Step 1: 写失败测试** —— 断言连接建立后，客户端发出的首个 `response.create` 携带显式开场 `instructions`（含 `suggestedOpening` 文案，且不含"你好/最近怎么样"）。读现有 `bailianWebsocket.test.ts` 的 mock-WS 收发断言结构照搬。
- [ ] **Step 2: 运行确认失败**。
- [ ] **Step 3: 实现** —— `onopen` 发完 `sessionUpdate` 后，首轮改为 `ws.send(JSON.stringify({ type: "response.create", response: { instructions: \`直接说出这句开场，不要任何寒暄或自我介绍：${session.openingLine}\` } }))`。`openingLine` 由 `createWebsocketSession` 入参带入（来自 `card.suggestedOpening`）。注意：仅**首轮**用 instructions 覆盖；后续轮次不带。
- [ ] **Step 4: 运行通过**。
- [ ] **Step 5: Commit** — `git commit -m "fix(voice): script the WS opening turn from suggestedOpening (no improvised small-talk)"`

> WebRTC 路径无显式首轮 `response.create`（靠 session 配置），其开场由 Task 2 的 prompt 铁律约束；如实测仍漂移，再补与 WS 等价的首轮指令。

---

### Task 6: LiveKit agent 去硬编码问候 + 开场用 suggestedOpening

**Files:** Modify: `agent/main.py:43-50, 74-76`；（`agent/interview_tools.py` 已能拉 agent-context）。

- [ ] **Step 1**: `main.py` 的静态 `instructions` 精简为"占位/兜底"，真正的 persona 由 `get_interview_context()`（agent-context → 域版语音 prompt，Task 2 已统一）注入。
- [ ] **Step 2**: **删除** `main.py:74-76` 的 `generate_reply("向用户问好…")`；改为：从 agent-context 取 `card.suggestedOpening`，`await session.generate_reply(instructions=f"直接说出这句开场，不要寒暄或自我介绍：{opening}")`。
- [ ] **Step 3**: 因属 Python、不在 JS 测试套内 —— 手动验证：起 `livekit-server --dev` + `python agent/main.py`，切 `realtimeMode=livekit`，确认开场是跟踪点续接、无"问好"。（若不跑 LiveKit，至少静态检查 + 在 README 标注。）
- [ ] **Step 4: Commit** — `git commit -m "fix(voice/livekit): drop hardcoded greeting; open from suggestedOpening via unified agent-context"`

---

### Task 7: 兜底默认 `normalizeInstructions` 含开场铁律

**Files:** Modify: `apps/api/src/routes/realtime-voice.ts:478-482`；Test: `apps/api/src/routes/realtime-voice.test.ts`。

- [ ] **Step 1**: 改 `:212` 测试断言为稳定子串（`toContain("专访主持人")`）；新增断言：兜底串含"不寒暄/开场"意图。
- [ ] **Step 2**: 兜底串升级为含"直接进入正题、不寒暄"的一句话默认（仅在客户端未传 instructions 时用）。
- [ ] **Step 3**: `npx vitest run apps/api/src/routes/realtime-voice.test.ts` 绿。
- [ ] **Step 4: Commit** — `git commit -m "fix(voice): sane default instructions with opening discipline"`

---

### Task 8: 真 LLM gated E2E + 浏览器实测

**Files:** Create: `apps/api/src/e2e/voice-opening.real.test.ts`（scoped .env.local，`describe.skipIf(!key)`）。

- [ ] **Step 1**: 用真 key 建会话，取 `session` 后调用域版 `buildRealtimeVoiceInstructions(session, session.card)`；断言其含开场铁律 + `suggestedOpening` + 至少两条跟踪点（历史/知识债/盲区/立场）。（这是"指令正确装配"的回归，不实际跑 WS。）
- [ ] **Step 2（手动）**: 起 `dev:full`，浏览器进实时专访 → 启动语音 → 确认 **AI 第一句是跟踪点续接问题、无"你过得怎么样/我刚来"**；连说 2-3 轮，追问可见地钉具体/给二选一/抓矛盾。用 Preview MCP 抓 console + snapshot 留证。
- [ ] **Step 3: Commit** — `git commit -m "test(voice): gated assembly regression for unified opening + manual browser verification"`

---

### Task 9: 全量回归 + 同步所有会断的测试

- [ ] `npx vitest run`（更新爆炸半径 B 里所有断言人设串的测试为稳定子串）→ 绿（现 442 起步）。
- [ ] `npx tsc -b` → 0；`npm run typecheck:api` → 0；`npx playwright test` → 全绿（17 起步）；`npx vite build` → OK。
- [ ] **Commit** — `git commit -m "test: sync persona-string assertions across voice/text/route tests"`

---

## Self-Review

- **Spec coverage**：语音开场不自然 → Task 2(开场铁律)+Task5(WS 脚本化)+Task6(LiveKit 去问候)；跟踪点接回语音 → Task2(全 guide 注入)+Task3(删瘦副本)；张小珺技法补齐 → Task1(共享核)+Task4(文字复用)；统一防再漂移 → Task1+2+4+7（单一真源）；爆炸半径测试 → Task9。
- **Placeholder 扫描**：每个 Task 给了具体 prompt 文本 / 测试断言 / 文件行；Task6（Python）因不在 JS 套内显式标注为手动验证 + 静态检查，非 TBD。
- **类型一致性**：`buildRealtimeVoiceInstructions(session, card)` 签名贯穿 App.tsx/voice-instructions/turn-builder；`INTERVIEWER_CRAFT_RULES` 常量名、`buildVoiceOpeningDiscipline(card)` 签名在 Task1 定义、Task2/4 复用一致；`session.openingLine`（Task5）需在 `createWebsocketSession` 入参与 `RealtimeVoiceSessionRecord` 链路加一个字段——实现时同步加，否则改为从 `session.sessionUpdate.session.instructions` 里取（二选一，实现时定）。

> 一个待你拍板的设计点：**LiveKit 路径（Task6）要不要这轮做？** 你默认 `realtimeMode="bailian"`（WS），LiveKit 需要另起 livekit-server+python agent 才生效。若暂不跑 LiveKit，可把 Task6 降为 P2/延后，先把 WS 这条主路（Task1-5,7-9）做实。
