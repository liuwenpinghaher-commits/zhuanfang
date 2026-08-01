# 资产对话端到端经营台优化报告（2026-08-01）

## 目标
把「资产对话」从能聊的侧栏提升为与素材库/笔记同级的**经营闭环**：真新对话、诚实 grounding/错误、精确跳源、跨模块预填、回答可开专访。

## 交付摘要

### S1 正确性
- **草稿线程** `ASSET_CHAT_DRAFT_ID`：点「新对话」不再回落最近会话；首次发送 `sessionId=null` 建新会话。
- **错误透传**：UI 展示 API `error`（429/503/502 等），网络失败同步持久化标志。
- **groundingMode**：写入 `ChatMessage` + UI pill（已依据 / 部分 / 拒召）。
- **引用跳源**：note→笔记场次、memory→记忆高亮、material→展开素材、theme→Track、point/decision/debt→资产 key+filter；transcript 保持轮次高亮。
- **URL**：`?view=asset-chat` + 可选 `chat=` / `chat=new`；离开清 my-assets 专用 query。
- **首问自动标题**：服务端首条 user 消息将默认「新对话」改为问题截断。

### S2 经营
- 空态推荐问法（主题/笔记/债或通用）。
- 会话列表：时间 + 末条摘要。
- 素材库「去资产对话」带预填；我的资产「问资产」。
- 回答后「就这个开专访」。
- 索引近空提示 → 去素材库。

## 验证
- `npm run typecheck` PASS
- vitest：`AssetChatView` 3 + `chat` route 11 PASS（含 auto-title / groundingMode）

## 关键文件
- `src/features/chat/AssetChatView.tsx` (+ test)
- `src/App.tsx`、`src/api/productApi.ts`、`src/domain/{types,knowledge}.ts`
- `apps/api/src/routes/chat.ts` (+ test)
- material / memory / my-assets / assets 视图接线
- `src/styles.css` chat 经营样式

## 生产注意
API 行为变更（标题 + grounding 落库）需 **rebuild api 容器** 后生效；纯前端部分热更/前端 rebuild 即可。
