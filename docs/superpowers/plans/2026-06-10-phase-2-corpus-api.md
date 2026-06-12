# Phase 2 Corpus Learning API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans and superpowers:test-driven-development to implement this plan task-by-task.

**Goal:** Move imported interview analysis behind the Product API so text/audio transcript learning can persist insights and proposed PlaybookPatch records server-side.

**Architecture:** Add `POST /api/corpus/insights`. The route reads current state, runs the existing corpus analyzer, persists `corpusImports`, `corpusInsights`, and `playbookPatches`, and returns `{ insight, state }`. The frontend calls the API first and falls back locally when unavailable.

## File Structure

- Create: `apps/api/src/routes/corpus.ts`
- Modify: `apps/api/src/server.ts`
- Modify: `apps/api/src/server.test.ts`
- Modify: `src/api/productApi.ts`
- Modify: `src/api/productApi.test.ts`
- Modify: `src/App.tsx`

## Tasks

- [ ] Add failing API test for `POST /api/corpus/insights`.
- [ ] Implement and register the route.
- [ ] Add failing client test for `analyzeCorpusImport()`.
- [ ] Implement client method.
- [ ] Update `App.analyzeCorpus()` to use API first and preserve fallback.
- [ ] Verify unit, build, and E2E.
