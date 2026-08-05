# 功能闭环改进方案（真实可落地）

> **日期：** 2026-08-05  
> **状态：** **已实现（A–E 工程切片）** · 2026-08-05  
> **验证：** `node scripts/loop-workflow-smoke.mjs` + domain vitest（revisit/loop/craft/session）  
> **基线：** `main` @ Realization Must-set 之后（craft golden / memory discipline / longitudinal 已绿）  
> **目标一句话：** 不堆新模块，把「专访 → 沉淀 → 确认 → 回访 → 再专访」收成**用户走得完、系统接得上、可验收**的硬闭环。  
> **配套差距表：** 会话内「现状 vs 理想差距表」（工程齐、产品断点在启动召回显性化 / 会中可感知 / HITL 粘性 / IA 碎片 / 真人 D4）

---

## 0. 为什么现在改「闭环」而不是再扫全系统

| 判断 | 依据 |
|------|------|
| 引擎与门禁大体齐 | craft golden、confirmed-only packing、conflict 409、doNotSave 诚实、纵向边生产消费 |
| 仍「像工具不像专访编辑」 | 会中策略/回访队列对用户半透明；结束→记忆可被 dismiss 后遗忘；Home 建议偏主题热度，非待办优先 |
| Wave D（长播客/多搜融合/a11y） | **不挡闭环**；本方案默认不排期，除非用户真痛 |

**原则（强制）：**

1. **只改服务主闭环的断点** — 不服务「问更深 / 记更准 / 下次回访 / 看见变化」的不做。  
2. **薄切片、可独立合并** — 每切片有域纯函数 + 单测 + 已部署 demo 冒烟（不新起平行环境）。  
3. **诚实** — 无假模板、无静默记忆、无「已完善」空话。  
4. **Cascade + 文本** 为主验证路径；Omni/LiveKit 不进本方案质量承诺。  
5. **Grok 运行机禁重活** — 依赖/全量测/compose 在 demo 或 CI；本机只改代码与轻检查。

---

## 1. 目标闭环（验收真源）

```text
① 启动：Home 用「待办优先」说明今天为什么聊
     ↓
② 会前：guide/context-pack 装入债·决策·confirmed 记忆·主题（已有）
     ↓ 且 UI 让用户看见「本场会回访什么」
③ 会中：策略可感知；用户能跳过/钉住线索（不丢进黑箱）
     ↓
④ 结束：笔记落盘；待审记忆 → 粘性任务，不可无痕消失
     ↓
⑤ HITL：approve/reject/conflict；仅 confirmed 进下次 packing
     ↓
⑥ 回访：下次一键开始必须消费 ⑤ 与到期决策/债/主题 nextQuestion
     ↓
⑦ 看见变化：主题 Track + 雷达/复盘用真实数据（已有底座）
```

**闭环通过定义（产品级，可手工跑通）：**

> 在 demo 上：开一场决策/日常专访 ≥6 轮 → 结束有笔记 → 审过 ≥1 条记忆 → 回到 Home 建议明确引用该记忆/债/决策 → 再开一场时 opening/guide 能指到上次内容 → Track 能看到两场同主题。

自动化只覆盖可确定性部分；**D4 真人 4 周** 见 Phase E，不伪造分数。

---

## 2. 断点诊断（改什么、为什么）

| ID | 断点 | 现状 | 理想 | 根因类型 |
|----|------|------|------|----------|
| B1 | **下次聊什么** | `buildInterviewCard` 偏 topTheme / focusQuestion / brief；Home 无统一「认知待办」 | 优先级：未完成会话 > 待审记忆 > 到期决策 > 开放债 > 主题 nextQuestion > 冷启动 | 域排序 + Home UI |
| B2 | **结束→确认粘性** | 上场摘要可关闭；关后待审记忆无全局提醒 | 有 pending 时全局 sticky，清零才消失 | 展示状态 + 派生计数 |
| B3 | **会中黑箱** | `strategyTrace` / guide 在引擎；Interview 几乎不展示回访清单 | 可折叠「本场回访 / 本轮策略」 | 前端读已有 session 字段 |
| B4 | **线索可操作** | turn-builder 有跳过锚点文案；无线索池 UI | 展示 openDebts/decisions/矛盾；支持「本场不追」写回 session 元数据 | UI + 轻量 session 字段 |
| B5 | **资产经营碎** | notes / my-assets / assets 多入口 | 档案按会话聚合入口统一 | IA（R2 未完） |
| B6 | **回访可测** | craft golden 测策略；**不测**「结束→下次 card 标题/whyNow」 | 增加 loop golden：finalize 后 card 必含回访锚 | 域测 |
| B7 | **真人价值** | 工程绿 | 4 周协议 | 产品验证，非堆功能 |

**明确不改（本方案非目标）：**

- 多租户 / CRDT / 第二 LLM 厂商  
- 播客长 TTS 分段、多搜索融合（D1/D2 增强）  
- 全站 a11y 大扫、OTEL 看板  
- 重写引擎或换库  
- 「自动完美记忆」绕过 HITL  

---

## 3. 分阶段实施（按闭环依赖排序）

```text
Phase A  回访待办与启动召回（B1 + B6 前半）     ← 闭环心脏
Phase B  结束→HITL 粘性（B2）                    ← 记得更准的用户面
Phase C  会中可感知编辑（B3 + B4）                ← 问得更深的信任
Phase D  经营台合一薄切片（B5）                   ← 降低丢资产
Phase E  质量协议与 demo 全环冒烟（B6 后半 + B7） ← 证明闭环
```

每 Phase：**可独立交付、可回滚、有 DoD**。禁止「A–E 一次大 PR」。

---

### Phase A — 回访待办与启动召回（最高 ROI）

**意图：** 用户打开产品就知道「系统记得欠我一场回访」；一点开始，guide 与 card 同源。

#### A1. 域函数 `buildCognitiveRevisitQueue(state)`

**做什么：** 从 `ProductState` 纯函数产出有序待办，供 Home / card / 推荐 launch 共用。

**建议优先级（固定、可单测）：**

| 序 | kind | 条件 | CTA |
|----|------|------|-----|
| 1 | `resume_session` | 进行中会话（已有 resume） | 继续 |
| 2 | `memory_hitl` | `memoryCandidates` status=pending 数量 > 0 | 去记忆治理 |
| 3 | `decision_due` | decision 待复盘 / daysOpen 超阈（复用 guide 同源逻辑） | 开 decision 模式 |
| 4 | `debt_open` | debt status 待了解等 | 开专访并 topicHint=概念 |
| 5 | `theme_next` | theme.nextQuestion 非空且成熟度非关闭 | long-term + themeId |
| 6 | `focus_question` | 会后反馈问题（`findNextInterviewFocusQuestion`） | 继续追问 |
| 7 | `cold_start` | 以上皆空 | 今日自由开场 |

**输出形状（示意）：**

```ts
type RevisitItem = {
  id: string;
  kind: "resume_session" | "memory_hitl" | "decision_due" | "debt_open" | "theme_next" | "focus_question" | "cold_start";
  priority: number;
  title: string;
  reason: string;           // 一句 whyNow
  mode?: InterviewMode;
  topicHint?: string;
  relatedThemeIds?: string[];
  href?: { view: View; focusId?: string };
};
```

**触点：**

- 新文件：`src/domain/revisit-queue.ts` + `revisit-queue.test.ts`  
- `buildInterviewCard`：当无 explicitTopicHint / 无 active brief 时，`title/whyNow/suggestedOpening` **优先吃 queue[0]**（与 guide 对齐，禁止两套文案）  
- `App.tsx` / `recommendedLaunch`：mode/topicHint/themeIds 来自 queue，不再只靠零散启发式  

**DoD：**

- [ ] 单测：仅 pending 记忆 → top 为 memory_hitl  
- [ ] 单测：仅 due decision → top 为 decision_due，且 `createSessionDraft` 后 `guide.decisionsToReview` 非空  
- [ ] 单测：approve 记忆后 queue 该项消失  
- [ ] 不改变 fail-loud / packing confirmed-only 语义  

#### A2. Home「认知待办」条

**做什么：** 在 resume 卡与 Hero 之间（或 Hero 内）展示 top 1–3 待办；主 CTA 绑定 queue 而非空白「一键开始」。

**触点：** `HomeView.tsx` + 样式 token（沿用 panel）

**DoD：**

- [ ] pending 记忆时首页必见「N 条记忆待确认」且一点进 memory  
- [ ] 无待办时仍显示冷启动 Hero（不空死）  
- [ ] e2e 或组件测：构造 state 可见待办文案  

#### A3. Loop golden（域层）

**做什么：** 确定性剧本：造 decision 待复盘 → `buildInterviewCard` / queue 命中 → `createSessionDraft` → `decideInterviewStrategy` 首轮可为 `decision_review`（与 craft 衔接）。

**触点：** `src/domain/loop-golden.ts` + test，或扩展 `craft-golden.ts` 场景 6。

**DoD：** `vitest.domain.config` 下全绿；无 live key。

---

### Phase B — 结束→HITL 粘性

**意图：** 记忆不确认就不该「像没发生过」。

#### B1. 粘性「待确认」条

**规则：**

- `pendingCount = memoryCandidates.filter(c => c.status === "pending").length`  
- `pendingCount > 0` 时：Home **与** 全局壳（侧栏角标或顶栏条）常驻；**不能**仅靠可 dismiss 的上场摘要  
- 上场摘要 dismiss 只关「本场庆祝」，**不**清除 sticky  

**触点：**

- `App.tsx`：由 `productState` 派生 pendingCount（勿只信 lastInterviewSummary）  
- `session-end-presentation`：HITL 时 primary 仍引导 memory；补一句「未确认前不会进入下次召回」（已有类似文案则统一）  
- 可选：`MemoryGovernanceView` 顶栏显示「处理完可回首页开专访」  

**DoD：**

- [ ] 结束有 pending → 关摘要后 Home 仍有 sticky  
- [ ] 全部 approve/reject 后 sticky 消失  
- [ ] doNotSave 场不出现假 pending  

#### B2. 结束三路径 CTA（薄）

上场摘要按钮固定为：

1. **主：** 有 pending → 记忆；否则 → 本场笔记  
2. **次：** 我的资产 / 主题线（若本场 `relatedThemeIds`）  
3. **再次：** 用 queue 下一项「预约下次」（只预填 Home topic，不开第二场会话）

**DoD：** 手工路径 + 现有 finish hook 单测不回归。

---

### Phase C — 会中可感知编辑

**意图：** 用户感到「它在按清单采访我」，而不是黑箱聊天。

#### C1. 会中「本场回访」折叠面板

**数据（只读已有 session，禁止新后端）：**

- `session.guide.openDebts` / `decisionsToReview` / `debtToAddress`  
- `card.opinionEvolution` / `card.contradictions`（已有）  
- 最近 1 条 `strategyTrace` → 展示 `INTERVIEW_STRATEGY_LABELS`  

**UI：** Interview 主对话旁或顶栏折叠；默认收起，不抢对话（延续「对话优先」）。

**DoD：**

- [ ] 有 due decision 的会话可见「待复盘决策」条目  
- [ ] 无 guide 数据时面板空态诚实  

#### C2. 「本场不追」轻操作（可选但推荐）

**做什么：** 对某条 debt/decision 标记 `session.suppressedRevisitIds`（或现有 control 扩展），本场 strategy 跳过该项（同场不重复逻辑已有，扩展为用户显式抑制）。

**约束：** 只影响本 session；不改写资产状态；finalize 可写入 note「用户跳过回访 X」。

**DoD：** 单测 strategy 在 suppressed 时不选 `decision_review`/`debt_followup`。

#### C3. 阶段小结入口

复用已有控制动作（若有 stage-summary 类）：在折叠面板提供「请小结目前为止」一键 `onControl`，避免用户找不到。

**DoD：** 控制动作仍进 strategyTrace；无新 LLM 协议。

---

### Phase D — 经营台合一（薄切片，防丢资产）

**意图：** 降低「笔记在 A、资产在 B」导致闭环感知断裂。  
**不做完整 R2 大重构**，只做高收益薄片。

#### D1. 我的资产 · 档案 Tab（按 sessionId 聚合）

- Tab「档案」：最近会话列表 → 点开见 note 摘要 + 该场 points/questions/decisions/debts 计数与跳转  
- Tab「资产」：保持现有类型横切  

**触点：** `MyAssetsView.tsx`；域函数 `buildSessionArchiveRows(state)` 可放 `src/domain/session-archive.ts`（已有 archive 相关则复用）。

**DoD：** 专访结束后在档案 Tab 能看到该 session；点笔记进 Notes 阅读室。

#### D2. 导航文案校准（可选 0.5d）

- 播客保留但副文案强调「再表达」；不强制撤导航（避免大 IA 争论阻塞 A–C）  
- 若只改 label：风险低  

**非本 Phase：** 主题手工 CRUD/合并、embedding 聚类。

---

### Phase E — 质量协议与全环冒烟

#### E1. Demo 全环冒烟脚本（自动化能做的）

`scripts/loop-workflow-smoke.mjs`（对齐 notes/material smoke 风格）：

1. health  
2. 创建会话 + 2–3 轮 text turn（mock 或真实 key 分支）  
3. end → export 检查 note / candidates  
4. approve 一条 memory  
5. 再 GET state / 调 card 构建所需 API，断言 revisit 变化  

**验证环境：** **已部署 demo**（`www.qing.blue` / compose 栈），禁止为本脚本再起临时 Surreal。

#### E2. Rubric 半自动抽检模板

在 `docs/superpowers/eval/samples/` 放：

- `TEMPLATE.md`：一场 10 分制打分 + strategyTrace 粘贴位  
- 协议：每改策略或 prompt 后至少 1 场文本专访打分  

#### E3. 真人 D4 协议（不写进「代码完成」）

| 项 | 内容 |
|----|------|
| 周期 | 连续 ≥4 周，本人真实主题 ≥1 条 |
| 频率 | ≥ 每周 2 场或等价深度 |
| 通过 | 主观「愿继续用」+ 至少 1 条「回访真的接上了」事例 |
| 失败 | 只觉得像聊天 / 从不想确认记忆 / 从不开第二次 |

代码 Phase A–D 可宣称「闭环工程就绪」；**不可**宣称 D4 通过。

---

## 4. 切片排期建议（工程量量级）

| Phase | 估计 | 依赖 | 合并策略 |
|-------|------|------|----------|
| A1+A3 | 1–2d | 无 | 先合域+测，UI 可次日 |
| A2 | 0.5–1d | A1 | Home 接线 |
| B1+B2 | 0.5–1d | A 可选并行 | sticky 只依赖 pending 计数 |
| C1 | 0.5–1d | 无 | 只读 UI |
| C2 | 1d | C1 | 含 strategy 测 |
| D1 | 1–1.5d | 无 | 可与 C 并行 |
| E1 | 0.5–1d | A+B 后最有价值 | demo 冒烟 |
| E2–E3 | 文档+习惯 | 产品 | 不阻塞发版 |

**推荐执行序：** `A1 → A3 → A2 → B1 → C1 → E1 → D1 → C2 → E2`。  
C2/D2/E3 可按带宽插队。

---

## 5. 验证矩阵（每切片最低门槛）

| 层级 | 命令/动作 | 何时 |
|------|-----------|------|
| 域单测 | `REAL_PROVIDER_SMOKE=off npx vitest run --config vitest.domain.config.ts <files>` | 每 Phase 必跑相关文件 |
| typecheck | `npm run typecheck`（**demo 或 CI**，Grok 机内存紧时勿硬跑全量） | 有 TS 改动 |
| 组件/e2e | 仅触碰 UI 时加定向 Playwright；默认不扩全量 | A2/B/C/D |
| Demo 冒烟 | `curl` health + 脚本 E1 或手工闭环清单 | 合入 main 并部署后 |
| 红线不破 | fail-loud、confirmed packing、conflict 409、craft 5 场景 | 任何策略改动 |

**手工闭环清单（部署后 15 分钟）：**

1. Home 无 pending 时冷启动开 daily  
2. 聊出可沉淀内容 → 结束 → 见笔记  
3. 有候选则 sticky → 记忆治理确认 1 条  
4. Home 待办变化 → 再开一场 → 开场/历史参照出现 confirmed 向内容  
5. 主题线 Track 能看到关联会话  

---

## 6. 风险与回滚

| 风险 | 缓解 |
|------|------|
| card 与 guide 文案分叉 | A1 强制 queue 为唯一 whyNow 源；单测锁标题前缀 |
| sticky 骚扰用户 | 仅 pending>0；可「稍后」收起到角标，不可永久 dismiss 计数 |
| 会中面板打扰语音 | 默认折叠；移动端更短 |
| 档案 Tab 性能 | 只聚合最近 N 场会话 |
| 范围膨胀 | 任何 PR 描述必须映射 B1–B7；映射不上则拒合 |

回滚：域函数与 UI 分 PR；UI 回滚不影响已合 golden。

---

## 7. 成功画像（做完 A–E 后系统应变成什么样）

| 角色 | 感知 |
|------|------|
| 用户 | 「结束有事做 → 确认记忆 → 下次自动接上」；不是聊完就散 |
| 专访中 | 知道本场要回访哪笔债/决策；策略标签偶尔可见 |
| 经营 | 按场次回看笔记+资产，不靠翻多个菜单碰运气 |
| 工程 | loop golden + demo smoke 守护回归；D4 仍靠真人协议 |

**仍不会自动得到的（诚实边界）：**

- 专业编辑级文采  
- 语音「像真人主持人」的韵律与时机（韧性已另案）  
- 无 HITL 的完美档案  

---

## 8. 与现有文档关系

| 文档 | 关系 |
|------|------|
| `specs/2026-08-04-realization-must-set-adr.md` | 正确性底线；本方案在其上补**用户可走完的闭环** |
| `MAINTENANCE-ROADMAP.md` | Wave D 按需；本方案优先于 D1 播客/D2 融合 |
| `2026-06-19-R2-nav-consolidation.md` | Phase D 是 R2 的**最小可交付子集**，不取代全文 |
| `eval/interview-rubric.md` | Phase E2 直接使用 |
| `CURRENT-开放清单.md` | 执行时把 A–E 勾成新小节或链到本文件 |

---

## 9. 立即执行的第一刀（建议明天就能开 PR）

**只做 A1 + A3：**

1. 实现 `buildCognitiveRevisitQueue` + 单测（上述 4 条 DoD）  
2. 改 `buildInterviewCard` 在无显式线索时消费 queue  
3. 增加 loop golden 一则 decision 回访  
4. 文档：本文件状态改为「A 进行中」  

**不碰：** 语音栈、播客、搜索 provider、Surreal schema。

验收命令（轻量）：

```bash
REAL_PROVIDER_SMOKE=off npx vitest run --config vitest.domain.config.ts \
  src/domain/revisit-queue.test.ts \
  src/domain/loop-golden.test.ts \
  src/domain/craft-golden.test.ts \
  src/domain/context-pack.test.ts
```

部署后：Home 对「仅有一条待复盘决策」的账号，Hero 标题/whyNow 必须点名该决策。

---

## 10. 决策记录

| 决策 | 选择 | 理由 |
|------|------|------|
| 优先改启动/HITL/会中可见 vs 语音文采 | 前者 | 闭环断裂在「接不上」，不是「说得不够美」 |
| 待办排序是否可配置 | v1 固定表 | 可测、少争论；配置留给系统策略页后期 |
| 是否强制结束跳转 memory | 否，sticky 代替 | 尊重用户节奏，但不允许无痕消失 |
| 是否大合并导航 | 否，仅档案 Tab | 降风险；完整 R2 另立项 |

---

**文档结束。** 批准后按 §9 开第一刀；完整 A–E 收口后更新 `CURRENT-开放清单.md` 与 `ARCHIVE.md` 一笔。
