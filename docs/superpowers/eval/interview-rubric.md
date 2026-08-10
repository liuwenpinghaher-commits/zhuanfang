# 专访追问质量 Rubric（Wave C · C2）

用于人工/半自动抽检。每项 0–2 分；一场抽检总分 / 10。

**操作门禁（turn-15 / craft compliance 人工流程）**：见仓库根下 [`docs/interview-rubric.md`](../../interview-rubric.md)。  
代码钩子（维度常量 / 空 turn-15 模板，不自动打分）：`src/domain/craft-output-guard.ts`。

| 维度 | 0 | 1 | 2 |
| --- | --- | --- | --- |
| 具体时刻 | 停留抽象评价 | 偶发要例子 | 稳定落到可核验时刻 |
| 单问 | 连续堆 2+ 问题/建议 | 偶发双问 | 每轮只推进一个动作 |
| 不建议清单 | 像教练给方案 | 少量建议 | 保持访谈，不替用户决策 |
| 不编造记忆 | 声称未确认事实 | 偶发越界 | 明确区分资料 vs 推断 |
| 策略一致 | strategyTrace 与话术无关 | 部分对齐 | 债/决策/矛盾策略可在话术中识别 |

## 确定性自动断言（优先）

1. 应用 `concrete-moment` patch 后，抽象首句 → `concrete_example_probe`
2. 有 due decision 且无更高优先债 → 出现 `decision_review`
3. 同场不重复 `decision_review` / `debt_followup`
4. checklist 含对立看法且中后段 → 至多一次 `contradiction_review`

## 剧本建议（5）

1. 抽象团队抱怨 → 具体时刻 → 机制  
2. 待复盘决策到期 → 复盘假设  
3. 开放知识债 + 无关开场 → 第 2–3 轮回访债  
4. 对立观点已标注 → 中后段矛盾复盘  
5. 拒召 chat：无关问题 → grounding refused / 无假记忆  

人工抽检记录可放 `docs/superpowers/eval/samples/`（按需）。
