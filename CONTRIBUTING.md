# Contributing to Zhuanfang (专访日记)

Thank you for your interest in contributing to **Zhuanfang (专访日记)**! This document provides guidelines and instructions for local development, testing, and submitting pull requests.

感谢你对 **专访日记 (Zhuanfang)** 的关注与贡献！本文档说明本地开发环境搭建、质量门禁、测试规范与 Pull Request 提交流程。

---

## 1. Development Setup / 本地开发环境

### Prerequisites / 环境依赖
- **Node.js**: `>= 22.x`
- **npm**: `>= 10.x`
- **OS**: Linux / macOS / Windows (WSL2 recommended)

### Install & Start / 安装与启动

```bash
git clone git@github.com:liuwenpinghaher-commits/zhuanfang.git
cd zhuanfang
npm install
cp .env.example .env.local
```

For local development with the in-memory store or embedded SurrealDB:

```bash
# Start both Product API (:3210) and Vite Web UI (:3220)
npm run dev:full
```

---

## 2. Architecture & Honesty Principles / 架构与诚实性原则

1. **No Silent Fake Fallbacks in Production Paths / 生产路径禁止静默伪造兜底**:
   - Interview follow-ups, session finalization, memory extraction, and podcast script generation must surface honest `5xx` / `429` / `degraded` states when upstream providers are unconfigured or fail.
   - For offline/CI E2E testing, mock at the **network boundary** using `tests/e2e/fake-provider-server.mjs` (`:13230`), keeping application code on its real execution path.
2. **Verbatim Evidence Only ("只引用原话")**:
   - Extracted memories, points, decisions, and knowledge debts must anchor to verbatim user quotes (`evidenceQuote` / `keyQuote`). Never fabricate or paraphrase quotes as user statements.
3. **Two-Step Interview End & HITL Memory Governance ("点头之后，下场才认")**:
   - When an interview finishes with pending memory candidates, the UI must guide the user through memory review first before claiming the session archive is finalized.
4. **Zero Sensitive Data in Git / 严禁提交敏感信息**:
   - Never commit `.env`, `.env.local`, API keys, voice clone IDs, SQLite/SurrealDB files (`.data/`, `*.db`, `*.sqlite*`), or personal audio recordings (`*.wav`, `*.mp3`, `*.m4a`).

---

## 3. Quality Gates & Testing / 质量门禁与测试

Before opening a Pull Request, ensure all checks pass locally:

```bash
# 1. TypeScript type checking (Frontend + API + DB package)
npm run typecheck

# 2. Full unit & integration test suite (offline, no commercial API billing)
REAL_PROVIDER_SMOKE=off RATE_LIMIT_DISABLED=true npm test -- --run

# 3. Production bundle build
npm run build

# 4. Playwright E2E suite (runs on isolated ports :13210 / :13220 / :13230 with memory store)
npm run test:e2e
```

---

## 4. Pull Request Process / PR 提交流程

1. Create a feature or fix branch from `main` (e.g., `feat/topic-timeline` or `fix/cascade-endpointing`).
2. Keep commits focused and use Conventional Commits (`feat:`, `fix:`, `docs:`, `test:`, `refactor:`).
3. Add or update unit tests (`*.test.ts` / `*.test.tsx`) or Playwright E2E specs (`tests/e2e/*.spec.ts`) covering your change.
4. Verify that `npm run typecheck`, `npm test -- --run`, and `npm run build` exit with code `0`.

---

## 5. License / 开源协议

By contributing to Zhuanfang, you agree that your contributions will be licensed under the [MIT License](LICENSE).
