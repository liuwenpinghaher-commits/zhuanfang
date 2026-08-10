# SIC+ 分仓 demo 人工开启与双用户冒烟

**日期**: 2026-08-10  
**demo**: `ubuntu@82.157.130.140` / `app-zhuanfang-1`  
**设计**: `docs/design-zhuanfang-sic-plus-7eba31c0.md`（OQ-S2：先实现后人工开）

## 变更

| 项 | 值 |
|----|-----|
| `PRODUCT_USER_SCOPED_STATE` | **0 → 1**（env 已备份 `.env.production.local.bak.sic-scoped-*`） |
| 新增用户 | `smoke_a` / `smoke_b`（写入 volume `auth-users.json`；**未改** admin 密码） |
| 分仓目录 | `/app/.data/users/user_smoke_a/surreal`、`user_smoke_b/surreal` |
| legacy | `/app/.data/surreal` 仍为 `PRODUCT_LEGACY_OWNER=admin` |

## 冒烟结果

| 检查 | 结果 |
|------|------|
| 登录 smoke_a / smoke_b | 200 |
| A 写入 marker 笔记 | 200 |
| B 的 state **不含** A marker | PASS |
| B 写入 marker；A **不含** B marker | PASS |
| A 仍含自身 marker | PASS |
| `docker restart` 后 A marker 仍在 | PASS |
| health `ok/ready` | true/true |
| 容器 env `PRODUCT_USER_SCOPED_STATE` | 1 |

**ALL_PASS = true**

## 注意

1. **Secure Cookie + 本机 HTTP**：session cookie 带 `Secure`；用 `http://127.0.0.1` 测时 CookieJar 可能丢弃 Secure cookie，需手动带 `Cookie: zf_session=...`（浏览器 HTTPS 公网正常）。
2. **历史数据**：非 legacy 新用户首登为空仓/种子；admin 仍走 legacy，历史在共享库。
3. **回滚**：`PRODUCT_USER_SCOPED_STATE=0` 重启；`users/user_*` 磁盘保留、不自动合并。
4. 曾误清空 env 后已从 `bak.sic-scoped-*` 恢复；改 env 请只做字段替换、禁止整文件重写。

## 回滚命令

```bash
cd /opt/zhuanfang/app
# 设 PRODUCT_USER_SCOPED_STATE=0
docker compose --env-file .env.production.local up -d --force-recreate zhuanfang
```
