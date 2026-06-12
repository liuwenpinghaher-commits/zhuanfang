# Phase 2 Podcast API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans and superpowers:test-driven-development to implement this plan task-by-task.

**Goal:** Move podcast episode generation behind the Product API so real TTS/audio rendering can later replace the local placeholder without changing the UI workflow.

**Architecture:** Add `POST /api/podcast/episodes`. The route reads the current `ProductState`, calls the existing deterministic podcast generator, persists the updated state, and returns `{ episode, state }`. The frontend API client calls this route first and falls back to local generation when the backend is unavailable.

## File Structure

- Create: `apps/api/src/routes/podcast.ts`
- Modify: `apps/api/src/server.ts`
- Modify: `apps/api/src/server.test.ts`
- Modify: `src/api/productApi.ts`
- Modify: `src/api/productApi.test.ts`
- Modify: `src/App.tsx`

## Tasks

- [ ] Add failing API test for `POST /api/podcast/episodes`.
- [ ] Implement and register the route.
- [ ] Add failing client test for `generatePodcastEpisode()`.
- [ ] Implement client method.
- [ ] Update `App.createPodcast()` to use API first and preserve fallback.
- [ ] Verify unit, build, and E2E.
