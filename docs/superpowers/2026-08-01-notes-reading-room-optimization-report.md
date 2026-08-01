# 双轨笔记阅读室优化报告（2026-08-01）

## 目标
把「双轨笔记」从静态档案陈列收成**会后阅读室 + 回访发射台**：读双轨、抓原话、保存/开场回访问题、下钻原文，并与资产库分工清晰。

## 交付（S1 + S2 + 轻 S3）

### 阅读与回访
- Hero：有 nextQuestion 时主 CTA「用下个问题开场」，否则「再做一次复盘」
- 卡片问题行：保存到资产库 / 用此问题开场（带 topicHint + relatedThemeIds）
- 双轨与问题可「展开全部」；轻量记录 pill + 诚实空态
- 搜索 + 筛选（全部 / 有回访问题 / 轻量记录）

### 闭环连接
- 保存问题：去重；**留在笔记页**（不再强制跳资产库）
- 旁注增删有中文 notice
- 主题 chip → Track；生成播客；打开专访档案（高亮场次）
- 关键原话「查看来源原文」展开 RawMaterial（keyQuoteAnchor）
- 副标题明确：笔记=阅读回访，资产=状态治理

## 关键文件
- `src/features/notes/NotesView.tsx`
- `src/App.tsx`（saveNoteQuestion / annotation notice / notes props / archiveFocusSessionId）
- `src/features/my-assets/MyAssetsView.tsx`（focusSessionId）
- `src/styles.css` · empty-state 单测

## 验证
| 门禁 | 结果 |
| --- | --- |
| typecheck | PASS |
| empty-state / engine / my-assets 定向单测 | PASS |

## 使用提示
1. 顶栏空场仍可用「移除空场」清理（全局 resume）。
2. 「用此问题开场」会把问题带入专访 topicHint。
3. 已保存过的相同问题按钮会显示「已保存到资产」。
