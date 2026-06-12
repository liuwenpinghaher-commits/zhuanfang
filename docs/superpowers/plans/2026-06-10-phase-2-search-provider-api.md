# Phase 2 Search Provider API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans and superpowers:test-driven-development to implement this plan task-by-task.

**Goal:** Move search brief creation behind the Product API so AnySearch-like providers can run server-side and persist generated materials into the shared product state.

**Architecture:** Add `POST /api/search/briefs`. The route reads the current `ProductState`, runs the existing `SearchProvider` capability layer, converts successful/degraded provider output into a `SearchBrief`, persists the updated state through `ProductStateRepository`, and returns `{ brief, state, task }`. The frontend API client calls this route first and falls back to local demo generation when the API is offline.

**Tech Stack:** Fastify, existing SearchProvider capability, ProductStateRepository, Fetch API client, Playwright.

---

## File Structure

- Create: `apps/api/src/routes/search.ts` - server-side search brief route.
- Modify: `apps/api/src/server.ts` - register search route with repository.
- Modify: `apps/api/src/server.test.ts` - API route persistence coverage.
- Modify: `src/api/productApi.ts` - typed `createSearchBrief()` client method.
- Modify: `src/api/productApi.test.ts` - client request test.
- Modify: `src/App.tsx` - use Product API search first, local provider fallback second.

## Task 1: Failing API Search Route Test

- [ ] Add a test that posts a topic/provider to `/api/search/briefs`.
- [ ] Assert response includes a generated brief, degraded AnySearch task, and persisted state.
- [ ] Run `npm test -- --run apps/api/src/server.test.ts` and verify 404 failure.

## Task 2: Implement API Route

- [ ] Add request normalization for provider/topic/max sources/recency.
- [ ] Run `executeSearchProvider()`.
- [ ] On succeeded/degraded task, call `createSearchBriefFromInput()` and persist `nextState`.
- [ ] Register route in `buildApiServer()`.
- [ ] Verify API tests pass.

## Task 3: Frontend Client and App Integration

- [ ] Add failing client test for `createSearchBrief()`.
- [ ] Implement `ProductApiClient.createSearchBrief()`.
- [ ] Update `App.createSearchMaterial()` to try API first and preserve local fallback.
- [ ] Verify current search E2E still passes when API is absent.

## Task 4: Verification

- [ ] Run `npm test -- --run`.
- [ ] Run `npm run build`.
- [ ] Run `npm run test:e2e`.
