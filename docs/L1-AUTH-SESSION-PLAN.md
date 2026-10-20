# 专访（zhuanfang）L1 账密会话门禁 — 详细实施方案

**状态**: P0 已实现（A0–A5）；P1 分仓默认关闭（`PRODUCT_USER_SCOPED_STATE=1` 开启）  

**对齐参考**: Scribe3 `docs/L1-AUTH-ISOLATION.md` + `scribe3/auth/*`  
**公开入口假设**: `https://www.example.com/zhuanfang/`（外层 nginx 反代 → `app-zhuanfang-1:3210`）  
**栈**: React/Vite 前端 + Fastify Product API（`apps/api`）+ 嵌入式 Surreal（`PRODUCT_STORE=surreal`）

---

## 0. 一句话目标

把专访生产环境从 **「共享 `PRODUCT_API_TOKEN` 当浏览器会话」** 升级为与 Scribe 同构的 **「用户名 + 密码登录 → HttpOnly 会话 Cookie → 受保护 `/api/*`」**；机器凭证（Agent / CI / LiveKit worker）继续用 Bearer，但**不再作为人类登录 UX**。

---

## 1. 现状诊断（As-Is）

### 1.1 鉴权模型

| 项 | 现状 |
|----|------|
| 开关 | `DEPLOYMENT_PROFILE=production` **且** 配置 `PRODUCT_API_TOKEN` 时守卫生效（`apps/api/src/auth.ts`） |
| 人类入口 | `GET /api/runtime-bootstrap` **直接把共享 token 写入 Cookie** `product_api_token`（HttpOnly） |
| 凭证形态 | `Authorization: Bearer <token>` / `?token=` / Cookie 三者等价校验同一密钥 |
| 前端 | `productApi.ts` 默认 `credentials: 'include'`；可选 `sessionStorage.product_api_token` |
| 机器调用 | LiveKit agent（`agent/main.py`）用 `PRODUCT_API_TOKEN` Bearer 调 `/api/realtime-voice/agent-context/...` |
| 失败 | 生产未设 token → **拒绝启动**（fail-closed） |

### 1.2 问题（与 Scribe 改造前同类）

1. **Cookie 里装的是长期共享密钥**，不是会话：泄漏即全站通吃，无法单独吊销某次登录。  
2. **无用户身份**：无法做「人」的审计、限流、多用户数据隔离。  
3. **登录 UX 缺失**：用户感知不到「账号密码」，只是 bootstrap 静默塞 cookie。  
4. 与 Scribe 双产品同域（`example.com`）时，**两套 token 心智不一致**。

### 1.3 数据模型差异（影响「隔离」深度）

| | Scribe3 | Zhuanfang |
|--|---------|-----------|
| 主数据 | 多书 `work` slug，一书一 DB | **整站一份 ProductState**（笔记/专访/主题…） |
| 隔离自然单位 | `work.owner_user_id` | **按用户命名空间** 或 **整站单租户门禁** |

因此专访方案分 **两档交付**（见 §3）：

- **P0（必做）**：账密会话门禁（与 Scribe 登录体验一致）。  
- **P1（建议同迭代或紧随）**：多用户逻辑隔离（每人独立状态），对应 Scribe 的 L1 owner 隔离。

---

## 2. 目标模型（To-Be）

### 2.1 凭证分层

| 角色 | 凭证 | 存放 | 用途 |
|------|------|------|------|
| **人类用户** | 用户名 + 密码 → 会话 Cookie `zf_session` | HttpOnly Cookie | 浏览器 SPA 全量 `/api/*` |
| **机器** | `PRODUCT_API_TOKEN`（或新名 `PRODUCT_MACHINE_TOKEN`） | 仅服务端 env / agent env | LiveKit agent、脚本、健康探测以外的自动化 |
| **可选过渡** | 旧 Cookie `product_api_token` | 过渡期兼容 | 一到两版后删除 |

### 2.2 HTTP 契约（对齐 Scribe）

| 方法路径 | 未登录 | 说明 |
|----------|--------|------|
| `POST /api/auth/login` | 放行 | body: `{ username, password }` → `Set-Cookie: zf_session=...` |
| `POST /api/auth/logout` | 放行 | 清 Cookie |
| `GET /api/auth/me` | 401 / 200 | `{ username }` |
| `GET /api/health` | 放行 | 探活 |
| `GET /api/runtime-bootstrap` | **改语义** | 见 §4.3，不再下发共享密钥 |
| **其余 `/api/*`** | **401**（门禁开启时） | 有效 `zf_session` **或** 合法机器 Bearer |

### 2.3 Cookie 规则

| 项 | 建议值 |
|----|--------|
| 名称 | `zf_session`（与 Scribe `s3_session` 区分，避免同域冲突） |
| 属性 | `HttpOnly; SameSite=Lax; Path=/`；HTTPS 下 `Secure`（`PRODUCT_SESSION_SECURE` 或 `X-Forwarded-Proto`） |
| 载荷 | HMAC-SHA256 签名：`{ u: username, exp }`（与 Scribe 同构，stdlib/crypto） |
| TTL | 默认 7 天，`PRODUCT_SESSION_TTL_HOURS` |
| Path 注意 | 若站点挂在 `/zhuanfang/`，Cookie `Path` 建议 `/` 或 `/zhuanfang` 与反代一致，保证 API 与 SPA 同送 |

### 2.4 密码

- 存储：`pbkdf2_sha256$<salt>$<hex>`（Node `crypto.pbkdf2`，iterations ≥ 260000）  
- 校验：digest 级 timing-safe（与现有 `bearerMatches` 同安全意识）  
- 登录失败：统一 `401 { error: "invalid credentials" }`，不区分用户是否存在  

### 2.5 环境变量

| 变量 | 含义 |
|------|------|
| `PRODUCT_AUTH_ENABLED=1` | 开启账密会话门禁（推荐生产与 `DEPLOYMENT_PROFILE=production` 同时开） |
| `PRODUCT_SESSION_SECRET` | 会话签名密钥（启用必填，长随机） |
| `PRODUCT_BOOTSTRAP_USERS` | 首次灌库 `user:pass,user2:pass2`（用户表空时写入） |
| `PRODUCT_SESSION_SECURE` | 强制 Cookie Secure |
| `PRODUCT_SESSION_TTL_HOURS` | 默认 168 |
| `PRODUCT_AUTH_DB` | 用户 SQLite 路径，默认 `.data/auth.sqlite`（或与 state 目录并列） |
| `PRODUCT_API_TOKEN` | **机器 Bearer**（保留；语义文档改为 machine-only） |
| `PRODUCT_LEGACY_OWNER` / `PRODUCT_DEFAULT_USER` | P1：历史单租户状态归属的用户名（默认 `admin`） |

**兼容策略**：

- `PRODUCT_AUTH_ENABLED` 未开：保持现有 token 守卫行为（开发友好）。  
- 两者都开：人类必须会话；机器仍可用 Bearer `PRODUCT_API_TOKEN`。  
- **禁止**再把 `PRODUCT_API_TOKEN` 通过 bootstrap 写进浏览器 Cookie 作为主路径。

---

## 3. 多用户数据隔离（P1，建议写入同一方案）

### 3.1 推荐：状态按用户分仓（L1，单进程）

专访没有 Scribe 的「多书 slug」，自然隔离单位是 **用户**：

```text
Surreal NS=zhuanfang
  DB=user_<username>   # 每用户一份 ProductState + 附属库
或
  单 DB + 所有记录带 owner_user_id（改动面大，不推荐首版）
```

**首版推荐「每用户一个 Surreal DB（或 state 文件前缀）」**：

- `createSurrealStores(userId)` 打开 `user_<sanitized>`  
- 中间件解析会话后，把 `request.user` 注入；路由层 `getState()` 绑定该用户仓库  
- 历史数据：启动时若仅存在旧默认库，挂到 `PRODUCT_LEGACY_OWNER`（admin）名下  

### 3.2 首版可只做 P0

若工期紧：**P0 只做整站账密门禁**（所有登录用户共享当前这一份 ProductState，与今天相同）。  
P1 再分仓。方案实现顺序必须允许「只合 P0 也能上线」。

---

## 4. 后端改造设计（Fastify）

### 4.1 新模块布局（建议）

```text
apps/api/src/auth/
  passwords.ts      # hash/verify pbkdf2
  session.ts        # issue/parse zf_session
  users.ts          # sqlite users + bootstrap
  ownership.ts      # P1：user → store key（可选）
  index.ts          # isAuthGuardActive 扩展、resolveUser
```

现有 `apps/api/src/auth.ts` **演进而非推倒**：

- 保留 `bearerMatches`、机器 token 校验  
- 新增 `resolveSessionUser(cookie)`、`isHumanSessionAuthorized`  
- `isAuthorized` 变为：`sessionValid || machineBearerValid || (guard inactive)`

### 4.2 路由

在 `server.ts` 注册：

```text
POST /api/auth/login
POST /api/auth/logout
GET  /api/auth/me
```

登录成功限流：复用现有 `rate-limit` 严格桶（防爆破），prefix `/api/auth/login`。

### 4.3 改造 `runtime-bootstrap`

| 旧 | 新 |
|----|-----|
| 无条件 Set-Cookie 共享 token | 若已有有效 `zf_session` → `{ authRequired: true, authenticated: true, username }` |
| | 若门禁开且未登录 → `{ authRequired: true, authenticated: false }` **不下发密钥** |
| | 若门禁关 → `{ authRequired: false }` |

前端根据 `authenticated: false` 跳转登录页。

### 4.4 守卫钩子 `registerProductionAuth`

伪逻辑：

```text
if path exempt (health, login, logout, me?, runtime-bootstrap): pass
if not /api/*: pass
if session cookie valid: attach request.user; pass
if machine Bearer valid: attach request.user = machine principal; pass
else 401
```

`GET /api/auth/me`：无会话时 401（与 Scribe 一致）。  
`POST /api/auth/login|logout`：始终放行。

### 4.5 机器主体

- LiveKit agent 继续 `Authorization: Bearer $PRODUCT_API_TOKEN`  
- 映射为合成用户：`PRODUCT_MACHINE_USER`（默认 `__machine__`）  
- P1：机器可访问全部用户库 **或** 仅通过 sessionId 路由（保持现 agent-context 按 session 拉上下文即可，不强制全局扫库）

### 4.6 媒体 `?token=`

原生 `<audio src>` 仍无法带 Cookie 跨站时：

- **优先**：继续 `fetch`+blob（现 `fetchSessionAudioBlob` 已 credentials include）  
- **次要**：短期允许 `?token=` **仅接受短期 signed media ticket**（由已登录会话签发，TTL 分钟级），**不要**再塞长期 `PRODUCT_API_TOKEN`  
- 过渡期可保留 `?token=` 机器 token，但文档标明 deprecated  

---

## 5. 前端改造设计

### 5.1 登录页

- 新增 `src/features/auth/LoginPage.tsx`（或等价）：用户名 + 密码  
- 提交 `POST /api/auth/login`，`credentials: 'include'`  
- 成功后进入现有 App；失败展示统一错误文案  

### 5.2 启动流

```text
App mount
  → GET /api/runtime-bootstrap (credentials include)
  → 若 authRequired && !authenticated → 渲染 LoginPage
  → 若 authenticated 或 !authRequired → 现有产品流
  → 任意 API 401 → 清本地态 + 回 LoginPage
```

### 5.3 `productApi.ts`

- 保持 `credentials: 'include'`  
- **删除/降级** 把长期 token 写入 `sessionStorage` 的主路径  
- 可选：`logout()` → `POST /api/auth/logout`  
- 401 统一映射为 `AuthRequiredError`，UI 捕获  

### 5.4 与 `/zhuanfang/` base

- Vite `VITE_BASE=/zhuanfang/` 时，API 前缀与 Cookie Path 在部署文档写死验收清单  
- 反代需把 `/zhuanfang/api/*` 转到后端 `/api/*` 或保留前缀一致（以现网 nginx 为准，实施时核对）

---

## 6. 部署与同域

### 6.1 现网拓扑

```text
https://www.example.com
  nginx-ssl
    /           → scribe frontend
    /zhuanfang/ → app-zhuanfang-1:3210   （需确认是否已配；当前 compose 暴露 3210）
```

### 6.2 生产 env 增量（示例）

```bash
DEPLOYMENT_PROFILE=production
PRODUCT_AUTH_ENABLED=1
PRODUCT_SESSION_SECRET=<32+ bytes hex>
PRODUCT_BOOTSTRAP_USERS=admin:<强密码>
PRODUCT_SESSION_SECURE=1
PRODUCT_API_TOKEN=<仅机器用长随机>   # agent/CI 用，不进浏览器
PRODUCT_WEB_ORIGINS=https://www.example.com,https://example.com
```

### 6.3 Cookie 同域注意

- Scribe：`s3_session`  
- Zhuanfang：`zf_session`  
- **不要**共用 Cookie 名，避免串登录态  

### 6.4 与 Scribe 用户表是否统一

| 策略 | 利 | 弊 | 建议 |
|------|----|----|------|
| **分表独立**（各产品 SQLite） | 实现快、故障隔离 | 两套账密 | **P0 采用** |
| 统一 IdP / 共享用户库 | 一账通行 | 耦合、工期长 | 后续专题 |

P0：**独立用户库**，可用相同 bootstrap 用户名密码人工对齐体验。

---

## 7. 测试计划

### 7.1 单测（Vitest，对齐现有 `server.test.ts` 风格）

| 用例 | 期望 |
|------|------|
| 密码 hash/verify | roundtrip；错误密码 false |
| session issue/parse | 篡改/过期无效 |
| bootstrap users | 空表灌入；二次不重复 |
| 无会话 GET `/api/state`（auth on） | 401 |
| 登录后 GET `/api/state` | 200 |
| 错误密码登录 | 401 |
| 机器 Bearer 仍可访问受保护 API | 200 |
| runtime-bootstrap 不返回 token 明文 | body 无 secret |
| 登出后受保护 API | 401 |

### 7.2 集成 / e2e

- Playwright：打开页面 → 登录 → 进入工作台 → 登出再进需登录  
- 回归：`agent` 带 `PRODUCT_API_TOKEN` 拉 agent-context 仍成功  
- 生产 compose 冒烟：未登录 curl 401；登录 cookie 后 200  

### 7.3 明确不测（首版）

- OAuth/SSO、2FA、邮件找回  
- 跨产品统一登录态  
- L2/L3 容器级隔离  

---

## 8. 实施任务拆分（PR 级）

| 序号 | 任务 | 产出 | 依赖 |
|------|------|------|------|
| **ZF-A0** | 本方案入库 + env 示例注释 | 本文档、`.env.example` 草案 | — |
| **ZF-A1** | `auth/passwords|session|users` + 单测 | 纯函数层 | A0 |
| **ZF-A2** | `/api/auth/*` 路由 + 守卫改造 + runtime-bootstrap 去密钥 | 后端门禁 | A1 |
| **ZF-A3** | 登录页 + 启动分流 + productApi 401 处理 | 前端 UX | A2 |
| **ZF-A4** | 文档 / compose / agent README：机器 token 语义 | 部署说明 | A2 |
| **ZF-A5** | 生产启用 + 冒烟（example.com/zhuanfang） | 线上验证 | A3–A4 |
| **ZF-B1**（P1） | 每用户 state 分仓 + legacy 归属 | 多用户隔离 | A2 |
| **ZF-B2**（P1） | 用户 A/B 状态不可见测试 | 验收 | B1 |

建议 **首个可上线切片 = A0–A5（P0）**；B1–B2 作为紧随迭代。

---

## 9. 风险与对策

| 风险 | 对策 |
|------|------|
| 现网只靠 bootstrap cookie，改后全员掉线 | 上线窗口告知；bootstrap 改语义后必须登录一次 |
| Agent 忘记带 Bearer | 启动检查 `PRODUCT_API_TOKEN`；agent 日志 401 明确 |
| Cookie Path / base 不一致 | 部署清单强制 curl 双路径验收 |
| 与 Scribe 同域 CSRF | SameSite=Lax + 关键操作维持现有 rate limit；P1 可加 CSRF token |
| 用户库与 state 备份遗漏 | 备份脚本同时打包 `.data/auth.sqlite` |
| 误把 session secret 与 api token 混用 | 命名与文档强制分离；bootstrap 禁止写 api token |

---

## 10. 验收标准（Definition of Done）

### P0（账密门禁）

1. 生产开启后，未登录访问 `/api/state` → **401**。  
2. 用户名密码登录成功 → 收到 `zf_session`，可读写业务 API。  
3. `runtime-bootstrap` **响应体不含** 长期 `PRODUCT_API_TOKEN`。  
4. 登出后再次业务 API → 401。  
5. LiveKit agent 仅靠机器 Bearer 仍能拉 agent-context。  
6. 自动化测试覆盖登录成功/失败、会话门禁、机器 Bearer。  
7. 文档说明生产 env 与 `www.example.com/zhuanfang` 验收步骤。  

### P1（多用户，可选同迭代）

8. 用户 A 的 ProductState 对用户 B 的列表/导出/API 不可见。  
9. 历史单租户数据归属 `PRODUCT_LEGACY_OWNER`。  

---

## 11. 与 Scribe 实现对齐表（便于复用）

| 能力 | Scribe | Zhuanfang 映射 |
|------|--------|----------------|
| 密码 | `scribe3/auth/passwords.py` | `apps/api/src/auth/passwords.ts` |
| 会话 | `s3_session` HMAC | `zf_session` HMAC |
| 用户库 | SQLite `scribe3_auth.sqlite3` | SQLite `.data/auth.sqlite` |
| 登录 API | `/auth/login` | `/api/auth/login` |
| 门禁开关 | `SCRIBE3_AUTH_ENABLED` | `PRODUCT_AUTH_ENABLED` |
| 机器 token | `SCRIBE3_API_TOKEN` | `PRODUCT_API_TOKEN` |
| 资源隔离 | `work.owner_user_id` | P1: `user_<name>` state 分仓 |
| 前端登录 | `Login.jsx` | `LoginPage` + App 分流 |

算法与安全语义 **复制 Scribe 已验证方案**；语言栈用 TypeScript/Fastify 重写，**不共享进程**。

---

## 12. 建议实施顺序（你确认后开工）

1. **按 P0（A0–A5）实现并上线专访账密**，与 Scribe 登录体验一致。  
2. 观察一周：agent、语音、导出/清空无回归。  
3. 再开 **P1 分仓**，避免首版同时改鉴权 + 存储拓扑导致难排障。  

---

## 13. 开放决策（默认值已选，实现前可改）

| # | 问题 | 默认 |
|---|------|------|
| D1 | P0 是否多人共享一份状态？ | **是**（与今日相同），P1 再分仓 |
| D2 | Cookie 名 | **`zf_session`** |
| D3 | 是否保留 `?token=` 长期机器 token | **过渡保留给 agent**；浏览器媒体走 blob |
| D4 | 用户库是否与 Scribe 共用 | **否**（独立 SQLite） |
| D5 | 登录页语言 | **中文**（全局规则） |

---

**文档路径**: `docs/L1-AUTH-SESSION-PLAN.md`  
**下一步**: 你确认本方案（或指出要改的默认决策）后，按 **ZF-A1 → A5** 开工实现。
