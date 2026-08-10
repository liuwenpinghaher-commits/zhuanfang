# 专访工艺 · 人工门禁（turn-15 / craft / GATE-HUMAN-VALUE）

> 操作向 runbook。详细五维 0–2 量表见  
> [`docs/superpowers/eval/interview-rubric.md`](./superpowers/eval/interview-rubric.md)。  
> 确定性策略 golden（**非**开放域文采证明）见  
> [`docs/superpowers/eval/craft-golden.md`](./superpowers/eval/craft-golden.md)。  
> 样本模板：[`docs/superpowers/eval/samples/TEMPLATE.md`](./superpowers/eval/samples/TEMPLATE.md)。

## 0. 门禁分级总表

| 门禁 ID | 谁判定 | 阻塞合并？ | 阻塞 Phase 晋级？ | 最小 n | n 不足时 |
|---------|--------|------------|-------------------|--------|----------|
| craft-golden 5 场景 | CI / 本域单测 | **是**（自动化） | 是 | 全套绿 | CI 红，不合并 |
| craft compliance ≥80% | **人工** rubric | 否 | Phase 2→3 **建议** | 抽检回合约 **20** | `insufficient_data`，**不得**标 go |
| turn-15 tracking ≥70% | **人工** | 否 | Phase 晋级 **建议** | 长会话约 **5** 场 | `insufficient_data`，**不得**标 go |
| **GATE-HUMAN-VALUE** | **产品/人工书面** | 否 | 产品宣称「真人价值达标」时 | 见 §4 | `insufficient_data`；**工程 PR 永不标 GO** |

本页只规定 **人工** 流程；**禁止**把 turn-15 / GATE-HUMAN-VALUE 伪造成自动 CI 绿。

---

## 1. 名称澄清：GATE-HUMAN-VALUE ≠ MAINTENANCE D4.a11y

| ID | 含义 | 文档位置 | 是否本页 |
|----|------|----------|----------|
| **GATE-HUMAN-VALUE** | 真人使用后是否感到「被认真访谈 / 有收获」的**产品价值**门禁（SIC+ S5） | 本页 §4；设计 doc SIC+ | **是** |
| **turn-15 tracking** | 约第 15 用户回合追问是否仍贴题/还债 | 本页 §3 | **是** |
| craft compliance | 五维 rubric 会话抽检达标率 | 本页 §2 | **是** |
| **MAINTENANCE D4.\* a11y** | Wave D **无障碍 / 键盘路径 / 移动** 维护切片 | [`docs/MAINTENANCE-ROADMAP.md`](./MAINTENANCE-ROADMAP.md) | **否** — 勿与 HUMAN-VALUE 混谈 |

**硬规则：**

- 合并 PR、关 issue、写 CHANGELOG 时，**不得**用「a11y 做了」代替 GATE-HUMAN-VALUE。  
- 工程 PR **不宣称** GATE-HUMAN-VALUE GO（即使 craft-golden 全绿）。  
- 自动化只证明策略/回归；**真人价值**只能人工书面结论。

---

## 2. 五维速查（每维 0–2，总分 /10）

1. **具体时刻** — 落到可核验实例，而非抽象评价  
2. **单问** — 每轮只推进一个动作（双问/建议堆叠扣分）  
3. **不建议清单** — 保持访谈，不替用户决策  
4. **不编造记忆** — 区分资料 vs 推断  
5. **策略一致** — strategyTrace / 话术可对齐

代码钩子（类型与空模板，**不**自动打分）：

- `INTERVIEW_RUBRIC_DIMENSIONS` / `emptyTurn15TrackingHook` — `src/domain/craft-output-guard.ts`

---

## 3. turn-15 抽检（人工 runbook）

### 3.1 何时做

- 改策略 / prompt / 回访队列 / 语音默认路径后，至少抽检一场 **cascade 默认路径** 长会话。  
- Phase 晋级讨论前：累计够最小 n（约 5 场带 turn-15 记录的长会话）。

### 3.2 步骤

在**同一场**会话中，到约第 15 个用户回合（或等价中后段）时：

1. 暂停或回放该回合主持人追问（语音可听录音 / 看 transcript）。  
2. 对照五维打分，填 `docs/superpowers/eval/samples/`（可用 `TEMPLATE.md`，并补 turn-15 字段）。  
3. **tracking**：追问是否仍接得上本场主题 / 未还知识债 / 用户刚说的具体词？  
4. 记录：`trackingOk`（是/否）、`rubricTotal`（0–10）、备注、`path`、`operator`。  
5. 汇总：tracking 通过场次 / 有判定的场次 → 比率；**不得**在 n 不足时写「≥70% go」。

### 3.3 判定

| 结果 | 条件 |
|------|------|
| **go（建议）** | 有判定长会话 ≥ 5 **且** trackingOk 比率 ≥ 70% |
| **no-go** | n 足够但比率 &lt; 70%，或系统性跑题 |
| **`insufficient_data`** | 有判定样本 **&lt; 5** 场 → **禁止**标 go / 禁止写「已达标」 |

---

## 4. craft compliance 会话抽检

- 同一操作人、相近环境；默认 cascade 路径。  
- 使用五维表；样本落盘 `eval/samples/`。  
- 设计目标：**抽检回合约 20** 后，合规回合占比 ≥ 80% 才可作为 Phase 2→3 **建议**依据。  
- 「持平/达标」以人工汇总为准，**不在本仓库伪造百分比**。  
- n &lt; 20 → 状态 **`insufficient_data`**，不得标 go。

---

## 5. GATE-HUMAN-VALUE（产品书面门禁）

### 5.1 定义

**GATE-HUMAN-VALUE** = 真实用户（或可信代理用户）完成至少一场完整专访后，是否认为：

1. 被认真倾听（非寒暄机器人 / 非建议清单）；  
2. 追问落到具体经历；  
3. 结束后有可回顾的笔记/记忆/主题线索（或诚实 doNotSave）；  
4. 愿意再开一场。

这是 **产品/人工** 结论，不是 vitest 绿。

### 5.2 最小证据包（落盘）

每次宣称评估时，在 `docs/superpowers/eval/samples/` 或会话笔记中保留：

```text
gate: GATE-HUMAN-VALUE
date:
operator:
demo_url_or_session_id:
path: cascade | bailian | livekit
sessions_scored: N
craft_compliance_note: (link or summary; or insufficient_data)
turn15_note: (link or summary; or insufficient_data)
user_value_verdict: go | no-go | insufficient_data
user_value_notes:
  - listened: yes|no|unclear
  - concrete: yes|no|unclear
  - after_session_artifact: yes|no|n/a
  - would_return: yes|no|unclear
engineering_pr_claims_go: false   # 必须始终 false
```

### 5.3 规则

| 规则 | 说明 |
|------|------|
| **insufficient_data** | 无真实会话样本、或 craft/turn-15 仍 `insufficient_data` 且无替代真人笔记 → **不得** HUMAN-VALUE go |
| **工程不标 GO** | 任何 `fix`/`feat` PR 描述不得写「GATE-HUMAN-VALUE 已通过」 |
| **≠ D4.a11y** | 键盘/读屏/对比度工作记入维护路线 D4，不关闭本门禁 |
| **与 golden 独立** | craft-golden 全绿 **不蕴含** HUMAN-VALUE go |

---

## 6. 可选输出护栏（机器辅助，非门禁）

| 项 | 说明 |
|----|------|
| Flag | `VOICE_CRAFT_OUTPUT_GUARD`（**默认 false**） |
| 行为 | true 时：多问号追问可截断为首问；其它违规打 `craft_output_guard` 日志（retry_logged），**不**自动二次 LLM |
| 回滚 | 设回 `false` 或 unset |
| 与 golden | 策略/检索 golden **独立**；flag 开/关都不得破坏 craft-golden |

---

## 7. 抽检记录最小字段（turn-15 / craft）

```text
date:
session_id / demo URL:
path: cascade | bailian | livekit
turn_index: 15 (or note if approximate)
rubric: concrete_moment=/2 single_question=/2 no_advice=/2 no_fabricate=/2 strategy=/2 total=/10
tracking_ok: yes|no|n/a
gate_status: go|no-go|insufficient_data
notes:
operator:
```

---

## 8. 相关链接

| 文档 | 用途 |
|------|------|
| [`docs/superpowers/eval/interview-rubric.md`](./superpowers/eval/interview-rubric.md) | 五维详表 |
| [`docs/superpowers/eval/craft-golden.md`](./superpowers/eval/craft-golden.md) | 自动 golden |
| [`docs/superpowers/eval/samples/TEMPLATE.md`](./superpowers/eval/samples/TEMPLATE.md) | 样本模板 |
| [`docs/MAINTENANCE-ROADMAP.md`](./MAINTENANCE-ROADMAP.md) | D4.a11y 等维护队列（**≠** HUMAN-VALUE） |
| [`docs/design-voice-system-cfc-plus-f77a7584.md`](./design-voice-system-cfc-plus-f77a7584.md) | 语音门禁分级与 insufficient_data 原则 |
