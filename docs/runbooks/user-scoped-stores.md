# Runbook · 多用户持久分仓（`PRODUCT_USER_SCOPED_STATE`）

**对应**：SIC+ PR-S3 / KD5–KD6 / KD15–KD18 / KD20  
**默认**：`PRODUCT_USER_SCOPED_STATE=0`（全站共享单一 Surreal 仓，行为与改造前一致）

## 架构摘要

| flag | 行为 |
|------|------|
| **0** | `startServer` 一次 `createSurrealStores`；热态+三冷层同连接 |
| **1** + session auth | `UserStoresRegistry`：legacy 预开现有 `…/surreal`；其他用户懒开 `…/users/user_<key>/surreal`；请求 pin + singleflight；shutdown `closeAll` |

**Machine Bearer**（`PRODUCT_API_TOKEN`）始终进 **legacy** 仓（`PRODUCT_LEGACY_OWNER`，默认 `admin`），不建独立机器目录。

## 开启前检查

1. 全站 export JSON（以 **legacy/共享库** 为准）。  
2. `PRODUCT_LEGACY_OWNER` = 现有主用户名。  
3. volume 可写 `…/users/` 子目录。  
4. 部署含 PR-S3 的镜像后 **先保持 flag=0** 冒烟。  
5. 生产必须：`PRODUCT_STORE=surreal` + session auth；**禁止** production + flag=1 + 内存工厂（启动硬拒，KD16）。

## 开启步骤

1. 维护窗口：设 `PRODUCT_USER_SCOPED_STATE=1`，重启 API。  
2. 已登录 **非 legacy** 用户看到 **空仓**（历史数据仍在 legacy）。迁出：legacy export → 用户登录后 import（无自动拆分）。  
3. 双用户冒烟：A 写笔记/raw；B 不可见；B chat 不得召回 A knowledge。  
4. `docker restart` 后 A 数据仍在。  
5. reset/import 仍走 governance tx。  
6. health：legacy persist 失败时 `ready=false`（聚合已打开仓）。

## 回滚

- 设 `PRODUCT_USER_SCOPED_STATE=0` 并重启。  
- `users/user_*` **保留在磁盘、不自动合并**。  
- UI 只见 legacy 数据。

## 备份

- 优先整 volume 快照。  
- 其次 per-user export JSON。

## 相关代码

- `apps/api/src/auth/user-stores-registry.ts`  
- `apps/api/src/auth/user-scoped-repository.ts`  
- `apps/api/src/auth/user-scoped-cold.ts`  
- `apps/api/src/server.ts`（`startServer` / `buildApiServer`）
