# 阶段 0b：删除 PostgreSQL Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 删除从未接线的 PostgreSQL 持久化路径(消解 P0-10、P1-17),让数据层只剩 SQLite 一条真实路径。

**Architecture:** 纯删除。顶层生产代码零引用这 4 个文件(已逐一验证),删除后无需改动任何其它代码;唯一 in-scope 引用是 `postgresMigration.test.ts`,与被引用文件同删。

**Tech Stack:** TypeScript, Vitest。

设计文档:`docs/superpowers/specs/2026-06-19-remove-postgresql-design.md`。

---

## Scope

对应 `docs/superpowers/plans/2026-06-18-data-model-v2-foundation.md` 的 Scope 段「0b 删 PostgreSQL」。

**删除(4 个文件):**
- `packages/db/src/pg-product-state-repository.ts`
- `packages/db/src/pg-schema.ts`
- `src/domain/postgresMigration.ts`
- `src/domain/postgresMigration.test.ts`

**严禁触碰:** `zhuanfang/`、`CLAUDE.md`、`memory/`、`.claude/`、`drizzle-orm` 依赖(SQLite `packages/db/src/schema.ts` 仍在用)。

---

## File Structure

本任务只删不改。被删文件与其责任、被引用情况(均已用 grep 验证):

- `packages/db/src/pg-product-state-repository.ts` — PG 版状态仓库。无任何顶层引用方(无 barrel),不在 `tsconfig.json`(`include:["src"]`)范围。
- `packages/db/src/pg-schema.ts` — PG drizzle schema。仅被上面那个仓库 import。
- `src/domain/postgresMigration.ts` — PG 迁移包构建逻辑。顶层仅被 `postgresMigration.test.ts` import(`zhuanfang/` 引用的是其自身副本 `zhuanfang/src/domain/postgresMigration.ts`,不依赖本文件)。
- `src/domain/postgresMigration.test.ts` — 上者的测试,在 vitest `src/**` 范围内,与被测文件同删。

---

## Task 1: 删除 4 个 PostgreSQL 文件并验证零破坏

**Files:**
- Delete: `packages/db/src/pg-product-state-repository.ts`
- Delete: `packages/db/src/pg-schema.ts`
- Delete: `src/domain/postgresMigration.ts`
- Delete: `src/domain/postgresMigration.test.ts`

- [ ] **Step 1: 记录删除前基线测试数**

Run: `cd "/Users/miaoma/Downloads/专访 1.0" && npx vitest run 2>&1 | tail -5`
Expected: 全绿(无失败)。记下 `Tests` 行的通过总数(基线,预期 511)。

- [ ] **Step 2: 复核 4 个文件无 in-scope 引用(删除前最后确认)**

Run:
```bash
cd "/Users/miaoma/Downloads/专访 1.0" && \
grep -rn "pg-product-state-repository\|pg-schema\|postgresMigration\|createPgProductStateRepository" src/ apps/ packages/ --include="*.ts" --include="*.tsx" \
  | grep -v "src/domain/postgresMigration.ts:" \
  | grep -v "packages/db/src/pg-product-state-repository.ts:" \
  | grep -v "packages/db/src/pg-schema.ts:" \
  | grep -v "src/domain/postgresMigration.test.ts:"
```
Expected: 无输出(空)。证明被删文件之外、顶层 `src/`+`apps/`+`packages/` 范围内零引用。
若有输出:停止,报告引用点,不要删除。

- [ ] **Step 3: 用 git rm 删除 4 个文件**

Run:
```bash
cd "/Users/miaoma/Downloads/专访 1.0" && git rm \
  packages/db/src/pg-product-state-repository.ts \
  packages/db/src/pg-schema.ts \
  src/domain/postgresMigration.ts \
  src/domain/postgresMigration.test.ts
```
Expected: `rm 'packages/db/src/pg-product-state-repository.ts'` 等 4 行,exit 0。

- [ ] **Step 4: 类型检查**

Run: `cd "/Users/miaoma/Downloads/专访 1.0" && npm run typecheck`
Expected: PASS(exit 0)。无 "Cannot find module" 等错误。

- [ ] **Step 5: 全量测试回归**

Run: `cd "/Users/miaoma/Downloads/专访 1.0" && npx vitest run 2>&1 | tail -5`
Expected: 全绿,无失败。通过总数 = Step 1 基线 − `postgresMigration.test.ts` 的用例数(因该测试文件被删)。确认无 *新增* 失败、无 "无法导入" 报错。

- [ ] **Step 6: 确认只动了这 4 个文件(防误吞无关改动)**

Run: `cd "/Users/miaoma/Downloads/专访 1.0" && git status --short`
Expected: staged 区(`D`)恰好是这 4 个被删文件。`zhuanfang`、`CLAUDE.md`、`memory`、`.claude/` 仍是未暂存(` M`/`??`),**不得**出现在 staged 区。

- [ ] **Step 7: 提交(仅这 4 个删除)**

Run:
```bash
cd "/Users/miaoma/Downloads/专访 1.0" && git commit -q -m "refactor(db): remove unwired PostgreSQL path (P0-10, P1-17)

删除从未接线的 PG 持久化:pg-product-state-repository、pg-schema、
postgresMigration 及其测试。顶层生产代码零引用(用 SQLite repo),
zhuanfang/ 引用的是自身副本不受影响。drizzle-orm 依赖保留(SQLite schema 仍用)。" && git log --oneline -1
```
Expected: 提交成功,仅含 4 个文件删除。

---

## Self-Review

**1. Spec 覆盖:** 设计文档列出的 4 个删除目标 = Task 1 删除清单,逐一对应。验证(typecheck + vitest)与设计 Testing 段一致。

**2. 占位扫描:** 无 TBD/TODO;每步均为确切命令 + 预期输出。

**3. 一致性:** 文件路径在设计文档、本计划 File Structure、Task 1 各步骤中完全一致。Step 2 的 grep 排除项逐字匹配 4 个被删文件路径。

**4. 安全:** Step 2 删前复核、Step 6 删后复核 git status 双重防护;提交命令显式列文件名,无 `git add -A/.`。
