# Craft golden 场景（realization Must-set）

确定性评测，**无 live LLM**。实现：`src/domain/craft-golden.ts`；测试：`src/domain/craft-golden.test.ts`。

| ID | 断言 | 驱动的 shipped 入口 |
|----|------|---------------------|
| `concrete_moment_probe` | 抽象首句 + `ruleType=concrete-moment` → `concrete_example_probe` | `decideInterviewStrategy` |
| `decision_review_once` | 待复盘决策 → 首轮 `decision_review`，同场不二次 | 同上 |
| `debt_followup_no_duplicate` | 开放知识债 → 首轮 `debt_followup`，同场不二次 | 同上 |
| `contradiction_review_mid_late_once` | `applyCognitiveRelations` 写 contradicts → checklist「对立看法」→ 中后段 `contradiction_review` 至多一次 | `applyCognitiveRelations` + `buildInterviewGuide` + strategy |
| `rag_grounding_refuse` | 无关知识块 + 高阈值 → `retrievePersonalKnowledge` rejected | `retrievePersonalKnowledge` |

运行：

```bash
REAL_PROVIDER_SMOKE=off npx vitest run --config vitest.domain.config.ts src/domain/craft-golden.test.ts
```

人工 rubric 仍见 [`interview-rubric.md`](./interview-rubric.md)。本 golden **不**证明开放域文采「专业编辑级」。
