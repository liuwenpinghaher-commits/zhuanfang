# 专访工艺 · 人工门禁（turn-15 / craft compliance）

> 操作向短文。详细五维 0–2 量表见  
> [`docs/superpowers/eval/interview-rubric.md`](./superpowers/eval/interview-rubric.md)。  
> 确定性策略 golden（**非**开放域文采证明）见  
> [`docs/superpowers/eval/craft-golden.md`](./superpowers/eval/craft-golden.md)。

## 目的

| 门禁 | 谁判定 | 阻塞合并？ | 阻塞 Phase 晋级？ |
|------|--------|------------|-------------------|
| craft-golden 5 场景 | CI / 本域单测 | **是**（自动化） | 是 |
| craft compliance ≥80% | **人工** rubric | 否 | Phase 2→3 建议 |
| turn-15 tracking ≥70% | **人工** | 否 | Phase 晋级建议 |

本页只规定 **人工** 流程；不把 turn-15 做成假自动 CI 门禁。

## 五维速查（每维 0–2，总分 /10）

1. **具体时刻** — 落到可核验实例，而非抽象评价  
2. **单问** — 每轮只推进一个动作（双问/建议堆叠扣分）  
3. **不建议清单** — 保持访谈，不替用户决策  
4. **不编造记忆** — 区分资料 vs 推断  
5. **策略一致** — strategyTrace / 话术可对齐

代码钩子（类型与空模板，**不**自动打分）：

- `INTERVIEW_RUBRIC_DIMENSIONS` / `emptyTurn15TrackingHook` — `src/domain/craft-output-guard.ts`

## turn-15 抽检（人工）

在**同一场** cascade 默认路径会话中，到约第 15 个用户回合（或等价中后段）时：

1. 暂停或回放该回合主持人追问。  
2. 对照五维打分，填 `docs/superpowers/eval/samples/`（可用 `TEMPLATE.md`）。  
3. **tracking**：追问是否仍接得上本场主题 / 未还知识债 / 用户刚说的具体词？  
4. 记录：`trackingOk`（是/否）、`rubricTotal`（0–10）、备注。  
5. 累计不足最小 n（设计：抽检回合约 20）→ 状态写 `insufficient_data`，**不得**标 go。

## craft compliance 会话抽检

- 同一操作人、相近环境；默认 cascade 路径。  
- 使用五维表；样本落盘 `eval/samples/`。  
- 「持平/达标」以人工汇总为准，不在本仓库伪造百分比。

## 可选输出护栏（机器辅助，非门禁）

| 项 | 说明 |
|----|------|
| Flag | `VOICE_CRAFT_OUTPUT_GUARD`（**默认 false**） |
| 行为 | true 时：多问号追问可截断为首问；其它违规打 `craft_output_guard` 日志（retry_logged），**不**自动二次 LLM |
| 回滚 | 设回 `false` 或 unset |
| 与 golden | 策略/检索 golden **独立**；flag 开/关都不得破坏 craft-golden |

## 抽检记录最小字段

```text
date:
session_id / demo URL:
path: cascade | bailian | livekit
turn_index: 15 (or note if approximate)
rubric: concrete_moment=/2 single_question=/2 no_advice=/2 no_fabricate=/2 strategy=/2 total=/10
tracking_ok: yes|no|n/a
notes:
operator:
```
