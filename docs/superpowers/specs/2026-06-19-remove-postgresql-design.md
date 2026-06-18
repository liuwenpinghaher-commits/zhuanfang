# 阶段 0b：删除 PostgreSQL 设计文档

**Goal:** 删除从未接线的 PostgreSQL 持久化路径(消解 P0-10、P1-17),让数据层只剩 SQLite 一条真实路径。

**Architecture:** 纯删除。顶层生产代码零引用这些文件,删除后无需改动任何其它代码。

## Scope

对应 `docs/superpowers/plans/2026-06-18-data-model-v2-foundation.md` 的 Scope 段「0b 删 PostgreSQL」。

**删除(4 个文件):**
- `packages/db/src/pg-product-state-repository.ts`
- `packages/db/src/pg-schema.ts`
- `src/domain/postgresMigration.ts`
- `src/domain/postgresMigration.test.ts`(顶层唯一 in-scope 引用方,与被引用文件同删)

**不动:**
- `zhuanfang/` 内的任何文件(无关未提交改动;其 postgresMigration 引用解析到 zhuanfang 自身副本,不依赖顶层)
- `CLAUDE.md`、`memory/`、`.claude/worktrees/`
- `drizzle-orm` 依赖(`packages/db/src/schema.ts` 的 SQLite schema 仍在使用)

## 验证后的爆炸半径

| 文件 | 在顶层 typecheck/test 范围 | 顶层引用方 |
|---|---|---|
| `pg-product-state-repository.ts` | 否(`tsconfig.json` 仅 `include:["src"]`) | 无 |
| `pg-schema.ts` | 否 | 仅 `pg-product-state-repository.ts` |
| `postgresMigration.ts` | 是(`src/`) | 仅 `postgresMigration.test.ts` |
| `postgresMigration.test.ts` | 是(vitest `src/**`) | 自身 import 被删文件 |

**安全结论:**
- 顶层生产代码使用 SQLite repo(`apps/api/src/server.ts` → `sqlite-product-state-repository`),零引用 PG 文件。
- 无 barrel/index 导出 PG 文件。
- `zhuanfang/` 被 `apps/api/tsconfig.json` 显式 exclude,且不在根 vitest include 模式内 → 删顶层文件不影响 zhuanfang,也不影响顶层验证。

## Testing

- `npm run typecheck` → PASS(exit 0)
- `npx vitest run` → PASS;总测试数从 511 减少(`postgresMigration.test.ts` 被删,其用例数随之移除),无失败、无新增。

## Git

只 `git add` 这 4 个被删文件的删除记录(`git rm`)。严禁 `git add -A/.`——仓库有大量无关未提交改动(`zhuanfang/`、`CLAUDE.md`、`memory/`)。
