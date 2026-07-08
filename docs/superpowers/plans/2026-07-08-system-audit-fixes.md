# System Audit Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 `docs/superpowers/2026-07-08-全系统再审查报告.md` 中 F-01 到 F-05 的全部确认问题，并用回归测试证明修复。

**Architecture:** 本次不重写系统，只收紧现有边界。状态类破坏性操作采用“先校验/预检，再提交”的原子语义；运行时 provider 改为通过 live getter 读取当前 client；realtime voice 改为统一使用注入 `runtimeEnv`。

**Tech Stack:** TypeScript, Fastify, Vitest, React API client, current repository abstractions.

## Global Constraints

- 不改无关业务行为，不丢弃现有脏文件。
- 不打印或提交 `.env.local` 中的 secret。
- 每个修复先写失败测试并确认失败，再改实现。
- 破坏性 API 的服务端契约必须比前端确认更强。
- runtime config 页面显示 ready 的能力，业务路由必须在同一 server 实例中可用。

---

### Task 1: Fix destructive state route atomicity and confirmation

**Files:**
- Modify: `apps/api/src/routes/state.ts`
- Modify: `apps/api/src/routes/state.test.ts`
- Modify: `src/api/productApi.ts`
- Modify: `src/api/productApi.test.ts`
- Modify: `apps/api/src/e2e/*.test.ts` reset helper call sites

**Interfaces:**
- Consumes: existing `ProductStateRepository`, `RawMaterialRepository`, `AudioRepository`, `KnowledgeIndexRepository`.
- Produces: `/api/state/import`, `/api/state/purge`, `/api/state/reset` with consistent destructive-operation semantics.

- [x] Add a failing test proving `/api/state/import` leaves hot state unchanged when raw material validation returns 422.
- [x] Add a failing test proving `/api/state/purge` does not clear hot state when a required cold-layer wipe fails.
- [x] Add a failing test proving `/api/state/reset` rejects requests without explicit confirm.
- [x] Move import raw/audio validation before `repository.replaceState`.
- [x] Preflight full purge cold-layer delete capability before hot-state replace, so failure returns before hot state changes.
- [x] Require reset confirm token and update API client/tests to send it.
- [x] Run `npx vitest run apps/api/src/routes/state.test.ts src/api/productApi.test.ts`.

### Task 2: Fix runtime provider refresh for business routes

**Files:**
- Modify: `apps/api/src/server.ts`
- Modify: `apps/api/src/routes/search.ts`
- Modify: `apps/api/src/e2e/real-llm-journeys.real.test.ts` or add focused API route test if better scoped

**Interfaces:**
- Consumes: mutable `providerClients` object and `refreshProviderClients`.
- Produces: search routes that read current provider clients after `/api/system/config` PATCH in the same server process.

- [x] Add a failing test proving PATCH `/api/system/config` enabling AnySearch changes `/api/search/briefs` behavior in the same server instance.
- [x] Introduce route options getter fields for provider clients, preserving existing direct-client injection compatibility.
- [x] Update business route registration to read live provider getters at request time.
- [x] Update `server.ts` registration to pass live getters instead of spread snapshots for search and related provider routes.
- [x] Run the focused provider refresh test.

### Task 3: Fix realtime voice env consistency

**Files:**
- Modify: `apps/api/src/routes/realtime-voice.ts`
- Modify: `apps/api/src/routes/realtime-voice.test.ts`

**Interfaces:**
- Consumes: `RealtimeVoiceRouteOptions.env`.
- Produces: `/api/realtime-voice/config`, `/api/realtime-voice/sessions`, ASR WS, and TTS WS using the same runtime env as capabilities.

- [x] Add a failing test proving injected env makes capabilities, `/config`, and session creation agree even when `process.env` is empty.
- [x] Pass `options.env ?? process.env` into realtime config/session helpers.
- [x] Make ASR/TTS WS provider resolution use the same env.
- [x] Run `npx vitest run apps/api/src/routes/realtime-voice.test.ts`.

### Task 4: Broaden provider live getter pattern where current registrations are stale

**Files:**
- Modify: `apps/api/src/server.ts`
- Modify: route files as needed where tests expose stale providers

**Interfaces:**
- Consumes: same `providerClients` object.
- Produces: no route should claim runtime-refresh support while retaining startup-only client snapshots.

- [x] Search route registrations using `...providerClients`.
- [x] Convert provider route options to live getters where runtime config should apply.
- [x] Leave storage/path settings with `restartRequired: true` unchanged.
- [x] Run targeted route tests touched by the conversion.

### Task 5: Full verification and report update

**Files:**
- Modify: `docs/superpowers/2026-07-08-全系统再审查报告.md`

**Interfaces:**
- Consumes: fresh test output.
- Produces: updated report marking F-01 to F-05 as repaired or documenting any remaining limitation.

- [x] Run `npm run typecheck`.
- [x] Run focused suites for changed route/API files.
- [x] Run `npm run build`.
- [x] Run `npx vitest run`.
- [x] Update report with repair summary and final verification status.
