# Interview Product MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a locally runnable product MVP for the voice-interview diary concept, centered on the full business loop from interview suggestion to guided session, dual-track notes, asset library, long-term themes, and review.

**Architecture:** A Vite + React + TypeScript single-page app owns the current product experience. Domain logic is isolated under `src/domain/` and tested with Vitest; external AI/realtime voice integrations are represented by deterministic local adapters so the full business loop can run without API keys.

**Tech Stack:** React 18, TypeScript, Vite, Vitest, lucide-react, browser localStorage.

---

## File Structure

- Create `package.json`: scripts and dependencies.
- Create `index.html`, `vite.config.ts`, `tsconfig.json`: Vite/TypeScript test/build setup.
- Create `src/domain/types.ts`: business domain types for profile, sessions, assets, interview state.
- Create `src/domain/seed.ts`: realistic demo state.
- Create `src/domain/engine.ts`: interview card generation, question strategy, finalization, asset creation, review metrics.
- Create `src/domain/storage.ts`: localStorage persistence.
- Create `src/App.tsx`: app shell and all product screens.
- Create `src/main.tsx`: React bootstrap.
- Create `src/styles.css`: complete responsive product UI.
- Create `src/domain/engine.test.ts`: tests for the core business loop.

## Task 1: Project Setup and Failing Domain Tests

- [ ] **Step 1: Add project configuration**

Create `package.json`, `tsconfig.json`, `vite.config.ts`, `index.html`, and `src/main.tsx` with a React/Vite/Vitest setup.

- [ ] **Step 2: Write failing tests first**

Create `src/domain/engine.test.ts` with tests for:

```ts
import { describe, expect, it } from "vitest";
import { buildInterviewCard, createInitialProductState, createSessionDraft, finalizeSession, receiveUserTurn } from "./engine";

describe("interview business engine", () => {
  it("builds a prepared interview card from unresolved themes and knowledge debts", () => {
    const state = createInitialProductState();
    const card = buildInterviewCard(state);
    expect(card.title).toContain("救火");
    expect(card.historyReferences.length).toBeGreaterThan(0);
    expect(card.suggestedPerspectives).toContain("系统论");
  });

  it("moves from user response to a sharper follow-up question", () => {
    const state = createInitialProductState();
    const session = createSessionDraft(state, "decision");
    const updated = receiveUserTurn(session, "我不想每次都替团队兜底，但又怕放手之后项目失控。");
    expect(updated.turns).toHaveLength(2);
    expect(updated.turns[1].role).toBe("assistant");
    expect(updated.turns[1].intent).toMatch(/追问|挑战|回访/);
    expect(updated.turns[1].content).toMatch(/兜底|失控|代价|机制/);
  });

  it("finalizes an interview into dual-track notes and long-term assets", () => {
    const state = createInitialProductState();
    const session = createSessionDraft(state, "decision");
    const afterFirst = receiveUserTurn(session, "我其实不是不想管，是不想每次都替他们兜底。");
    const afterSecond = receiveUserTurn(afterFirst, "如果我不救火，最坏是项目短期延期，但他们可能才会真的承担判断。");
    const result = finalizeSession(state, afterSecond);
    expect(result.note.saidTrack.length).toBeGreaterThan(0);
    expect(result.note.learnedTrack.length).toBeGreaterThan(0);
    expect(result.nextState.points.length).toBeGreaterThan(state.points.length);
    expect(result.nextState.questions.length).toBeGreaterThan(state.questions.length);
    expect(result.nextState.themes.some((theme) => theme.name === "控制感")).toBe(true);
  });
});
```

- [ ] **Step 3: Run tests to verify red**

Run: `npm install && npm test -- --run`  
Expected: tests fail because `src/domain/engine.ts` does not exist yet.

## Task 2: Domain Model and Business Engine

- [ ] **Step 1: Implement domain types**

Create `src/domain/types.ts` defining `ProductState`, `InterviewSession`, `InterviewCard`, `InterviewTurn`, `DualTrackNote`, `PointAsset`, `QuestionAsset`, `DecisionAsset`, `KnowledgeDebt`, `LongTermTheme`, `InterviewMode`, and `InterviewStrength`.

- [ ] **Step 2: Implement seed state**

Create `src/domain/seed.ts` with realistic profile, existing long-term themes, open knowledge debts, prior notes, points, questions, decisions, and transcript fragments.

- [ ] **Step 3: Implement engine functions**

Create `src/domain/engine.ts` implementing:

- `createInitialProductState`
- `buildInterviewCard`
- `createSessionDraft`
- `receiveUserTurn`
- `finalizeSession`
- `buildMonthlyReview`
- `markMemoryCorrection`
- `toggleAssetImportance`

- [ ] **Step 4: Run tests to verify green**

Run: `npm test -- --run`  
Expected: all domain tests pass.

## Task 3: Product UI and Local Persistence

- [ ] **Step 1: Implement storage**

Create `src/domain/storage.ts` with load/save/reset wrappers around localStorage.

- [ ] **Step 2: Implement app screens**

Create `src/App.tsx` implementing these screens:

- Home: today's suggestion, continue last, knowledge debt, long-term theme.
- Interview: card confirmation, live text/voice-ready interview, current intent, controls.
- Notes: dual-track notes and session archive.
- Assets: points, questions, decisions, knowledge debts.
- Themes: long-term theme tracking and monthly review.
- Profile: explicit profile, inferred memories, trust controls.

- [ ] **Step 3: Implement styling**

Create `src/styles.css` with responsive, dense, work-focused UI and clear visual hierarchy.

- [ ] **Step 4: Run build**

Run: `npm run build`  
Expected: TypeScript and Vite build pass.

## Task 4: Verification and Browser Check

- [ ] **Step 1: Run full verification**

Run:

```bash
npm test -- --run
npm run build
```

Expected: tests and build pass.

- [ ] **Step 2: Start dev server**

Run: `npm run dev -- --host 127.0.0.1`  
Expected: Vite serves the app and prints a localhost URL.

- [ ] **Step 3: Open in browser and inspect**

Open the localhost URL in the in-app browser. Verify:

- first screen is the product dashboard, not a landing page;
- interview can start from the prepared card;
- user input produces assistant follow-up;
- ending a session creates notes and assets;
- navigation to assets/themes/profile works.

- [ ] **Step 4: Final report**

Report exact verification commands and results, the local URL, and any remaining limitations.
