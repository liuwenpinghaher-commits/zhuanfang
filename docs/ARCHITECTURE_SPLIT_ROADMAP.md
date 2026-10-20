# 专访（zhuanfang）架构拆分规范

> **目标：降低审查与并行冲突；不改变产品语义与对外 HTTP/WS 契约。**  
> 参照 scribe3 拆分逻辑：领域分包、稳定 re-export、入口薄组装。  
> 关联：`README.md` · 部署：`deploy/prod` · 冒烟：已部署 demo（`www.example.com/zhuanfang/`）

## 1. 完成定义（Done）

| # | 标准 |
|---|------|
| S1 | 本文档列出 phase、非目标、兼容性规则与验证门槛 |
| S2 | API 路由继续按域 `register*Routes` 挂载；**超大文件**拆为子模块/services，入口 re-export |
| S3 | 百炼 provider（`bailian`）按能力分包，原路径 `providers/bailian` 仍可 import |
| S4 | 前端 `productApi` / `App` 上帝文件减负：类型与钩子外提 |
| S5 | 类型检查 + 相关单测通过；部署冒烟 health/登录（不新起平行环境） |

## 2. 兼容性铁律

1. **公开 API 路径与 method 不变**（含 WebSocket 语音路径）。
2. **产品语义不变**（鉴权 L1、状态 revision、限流、写门控）。
3. **稳定 import 路径**：`from "./providers/bailian"`、`from "./routes/interview-sessions"` 等继续可用（re-export）。
4. **禁止**按行数机械切 `server_1/2/3`；按领域边界。
5. **禁止**微服务化；不改 Surreal schema（除非搬迁绝对需要）。

## 3. 非目标

- 改业务规则、模型默认值、Hermes/百炼拓扑
- 前端 UI 视觉大改
- 全量 e2e 重写

## 4. Phase 地图

### Phase A — Provider 与超大路由减负

| 组件 | 目标 |
|------|------|
| `providers/bailian.ts` | → `providers/bailian/*`（chat/search/interview/realtime/podcast/transcription/embedding/…）+ 根文件 re-export |
| `routes/interview-sessions.ts` | 注册函数 + `helpers` / `turn` 服务 |
| `routes/realtime-voice.ts` | 注册函数 + `helpers` / session 构建 |

### Phase B — Server 组装与状态/搜索服务

| 组件 | 目标 |
|------|------|
| `server.ts` | 保持组装入口；超长 bootstrap 可下沉 `server/*`（本轮以 import 清晰为主） |
| `routes/state.ts` / `search.ts` | 过长时可再抽 services（按需） |

### Phase C — 前端

| 组件 | 目标 |
|------|------|
| `src/api/productApi.ts` | types 与 client 分包，`productApi.ts` re-export |
| `src/App.tsx` | 离线同步 / 语音会话等钩子外提到 `src/hooks/*` |

## 5. 验证

```bash
# API（在 demo 或本机有 node 时）
cd apps/api && npx tsc -p tsconfig.json --noEmit   # 若有独立 tsconfig
# 或 monorepo 根
npm test -- --run apps/api/src/routes/health.test.ts   # 轻量子集
# 已部署
curl -sS https://www.example.com/zhuanfang/   # 或 compose health
```

## 6. 基线（本轮前）

| 文件 | 行数约 |
|------|--------|
| `apps/api/src/providers/bailian.ts` | ~1600 |
| `apps/api/src/server.ts` | ~1424 |
| `apps/api/src/routes/interview-sessions.ts` | ~1251 |
| `apps/api/src/routes/realtime-voice.ts` | ~1147 |
| `src/api/productApi.ts` | ~1542 |
| `src/App.tsx` | ~3796（拆前；拆后见 §8） |

## 7. Checklist

- [x] 本规范
- [x] bailian 包拆 + re-export（`providers/bailian/*` + 根 `bailian.ts`）
- [x] interview-sessions / realtime-voice helpers 下沉
- [x] productApi types/client 分包
- [x] App 接入 `useOfflineProductSync`，检索/语料/playbook 动作进 hooks
- [x] `server.ts` 写门 / CORS·错误 / 鉴权·限流 / defaults / 优雅关闭整块下沉
- [x] App 访谈生命周期 / 实时语音开关进 hooks（`useInterviewSessionActions` / `useRealtimeVoiceControls`）
- [x] 验证与提交

## 8. 完成后体量（约）

| 文件 | 约行数 |
|------|--------|
| `providers/bailian.ts` | 2（re-export） |
| `providers/bailian/_impl.ts` | ~1600 |
| `providers/bailian/{chat,search,...}.ts` | 门面 |
| `routes/interview-sessions.ts` | ~1000（注册） |
| `routes/interview-session-helpers.ts` | ~325 |
| `routes/realtime-voice.ts` | ~814（注册） |
| `routes/realtime-voice-helpers.ts` | ~412 |
| `src/api/productApi.ts` | 3（re-export） |
| `productApi.types.ts` / `.client.ts` | ~772 / ~780 |
| `src/App.tsx` | ~2280（hooks 下沉后） |
| `useInterviewSessionActions.ts` | ~430 |
| `useRealtimeVoiceControls.ts` | ~680 |
