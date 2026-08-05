# 专访 Rubric 抽检模板

> 每改策略 / prompt / 回访队列后至少打一场文本专访。  
> 评分标准见 `docs/superpowers/eval/interview-rubric.md`（每项 0–2，满分 10）。

| 字段 | 填写 |
|------|------|
| 日期 | YYYY-MM-DD |
| 模式 | daily / decision / long-term / … |
| 轮数 | |
| 主题 | |
| 是否走 HITL | 是 / 否 · 确认几条记忆 |
| 下次是否接上 | 是 / 否 · 说明 |

## 分数

| 维度 | 分 | 备注 |
|------|----|------|
| 具体时刻 | /2 | |
| 单问 | /2 | |
| 不建议清单 | /2 | |
| 不编造记忆 | /2 | |
| 策略一致 | /2 | |
| **合计** | **/10** | |

## strategyTrace（粘贴）

```text
（从会话导出或控制台）
```

## 闭环检查

- [ ] 结束有笔记（或 doNotSave 诚实）
- [ ] 有 pending 时 sticky / 认知待办可见
- [ ] 确认记忆后待办变化
- [ ] 再开场 title/whyNow 或 guide 指向上次
- [ ] 主题 Track 能看到本场（若绑了 theme）
