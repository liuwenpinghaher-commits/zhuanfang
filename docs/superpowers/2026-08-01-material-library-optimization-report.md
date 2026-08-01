# 素材库优化报告（2026-08-01）

## 目标
把「素材库」从薄表单收成原料车间：导入结果可见、错误诚实、审核闭环、列表可经营、URL 不粘滞。

## 交付（S1 + S2）

### S1 信任与主闭环
- URL：`?view=material` 读写；离开 my-assets 清除 filter/important/sort，避免刷新错页
- 导入：`importMemoryDocument` 返回 sourceId/候选/切块/向量；失败透传 API error body
- 成功结果条 +「去审核候选记忆」→ 记忆页，并可按 import sourceId 聚焦待审

### S2 列表与消费
- 索引概览（素材数/块数/向量/待审候选）
- 搜索、预览、主题 chip、删除反馈
- 「用此素材开场」「去资产对话」「相关记忆」

## 验证
- typecheck PASS
- import + MemoryGovernanceView 单测 PASS
- empty-state MaterialLibraryView 文案

## 复现要点
1. 打开素材库后地址栏应为 `?view=material`
2. 导入成功出现结果条并可跳转记忆审核
3. 断网/503 时错误不再写死单一 DASHSCOPE 文案
