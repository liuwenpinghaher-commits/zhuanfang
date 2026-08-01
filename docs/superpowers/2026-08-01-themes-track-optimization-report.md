# 主题线 / Track 端到端优化报告（2026-08-01）

## 目标
把「主题线」从统计墙收成可经营的长期回访台：空场不挡路、复盘状态诚实、继续必带主题上下文、Track 可回流可钻取。

## 交付（S1 + S2）

### S1 信任修复
- 非 Home 的 resume 条支持 **继续 / 移除空场**（与 Home 对齐）
- 复盘 **SWR**：资产签名变化不清空旧结果；显式 `reviewsLoading` + `reviewsError` + **重试**
- 复盘三分态文案：生成中 / 不可用+重试 / 素材不足
- Hero CTA 绑定 topTheme；无主题时引导去完成专访
- Track **返回 → 主题线总览**（不再写死 Home）

### S2 主题闭环
- 列表行内「继续这条线」、Track「继续这条线」、Home「用此主题开始」均传 `topicHint` + `relatedThemeIds`
- `createSessionDraft` / `POST /api/interview-sessions` 支持创建时软归属 `relatedThemeIds`（非法 id 过滤）
- Track 三列钻取：专访→笔记、产出→我的资产（自动切资产库 tab）、资料→素材库
- 认知雷达去掉深度维 `Math.max(1,…)` 假 floor；全零空态诚实说明

## 关键文件
- UI：`ThemesView` · `TrackWorkspaceView` · `HomeView` · `MyAssetsView` · `App.tsx` · `styles.css`
- 域：`context-pack.createSessionDraft` · `review.buildCognitiveRadar` · `engine.CreateSessionOptions`
- API：`apps/api/src/routes/interview-sessions.ts` · `productApi.CreateInterviewSessionRequest`
- 测：`review.test` · `engine.test` · `empty-state-render` · `timeline-track` e2e

## 验证
| 门禁 | 结果 |
| --- | --- |
| typecheck | PASS |
| 定向单测（review/engine/empty-state） | 42/42 PASS |
| e2e `timeline-track` | 4/4 PASS（返回 themes、列表继续开场） |

## 明确未做（S3 可选项）
- 主题手工 CRUD / 合并删除
- 复盘本地模板叙事兜底（刻意不做）
- 列表筛选控件与年度回顾折叠动效的进一步视觉打磨
- embedding 级主题聚类

## 使用提示
1. 主题线页顶栏空场点「移除空场」即可清理。
2. 复盘失败点「重试」；慢请求时若有旧结果会保留并标「刷新中…」。
3. 「继续：{主题}」会开 long-term 并绑定该 themeId，结束后 Track「历次专访」可聚合。
