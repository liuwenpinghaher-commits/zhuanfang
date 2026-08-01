# 资产对话生产冒烟（2026-08-01）
> **结果：PASS** · base `http://127.0.0.1:3210` · tip `8806ce12`  
> 开始 2026-08-01T17:01:55.358Z · 结束 2026-08-01T17:02:44.755Z  
> 步骤 pass=14 fail=0 warn=0

## 命令

```bash
node scripts/asset-chat-prod-smoke.mjs
```

## 步骤

| 步骤 | 状态 |
| --- | --- |
| `health` | **pass** |
| `bootstrap` | **200** |
| `bundle-markers` | **pass** |
| `api-chat-new` | **pass** |
| `api-chat-append` | **pass** |
| `ui-open-asset-chat-url` | **pass** |
| `ui-session-list-title` | **pass** |
| `ui-grounding-and-cites` | **pass** |
| `ui-citation-click` | **pass** |
| `ui-new-chat-draft` | **pass** |
| `ui-draft-send` | **pass** |
| `ui-start-interview-cta` | **pass** |
| `ui-material-prefill` | **pass** |
| `ui-url-refresh` | **pass** |
| `api-empty-message-422` | **pass** |

## 关键断言
- health ok/ready；bootstrap 200
- bundle 含草稿线程 / 已依据资料 / 就这个开专访
- `POST /api/chat` 自动标题 + groundingMode 落库；同会话追加
- UI：`view=asset-chat`、新对话草稿空线程、草稿发送建会话、引用跳源、素材预填、开专访 CTA
- 空消息 422

## 脚本
`scripts/asset-chat-prod-smoke.mjs`
