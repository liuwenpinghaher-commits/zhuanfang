import { describe, expect, it } from "vitest";
import { createInitialProductState } from "./engine";
import { createIntelTask, ingestIntelItems, intelItemToKnowledgeDebt, updateIntelItemStatus } from "./intel";

const item = (url: string, overrides: Record<string, unknown> = {}) => ({
  title: "x",
  url,
  publisher: "e",
  summary: "s",
  relevance: 80,
  claims: [],
  category: "c",
  ...overrides
});

describe("intel domain", () => {
  it("creates a task and ingests items, deduping by url", () => {
    let state = createInitialProductState();
    const created = createIntelTask(state, { name: "T", keywords: ["a", "b"] });
    state = created.nextState;
    expect(state.intelTasks[0].id).toBe(created.task.id);
    expect(state.intelTasks[0].status).toBe("active");

    const run1 = ingestIntelItems(state, created.task, [item("https://e.com/1"), item("https://e.com/1", { summary: "dup" })]);
    expect(run1.count).toBe(1); // duplicate url dropped
    state = run1.nextState;
    expect(state.intelTasks[0].lastRunAt).toBeTruthy();

    const run2 = ingestIntelItems(state, created.task, [item("https://e.com/1")]);
    expect(run2.count).toBe(0); // already seen
  });

  it("updates item status", () => {
    let state = createInitialProductState();
    const created = createIntelTask(state, { name: "T", keywords: ["a"] });
    state = ingestIntelItems(created.nextState, created.task, [item("https://e.com/2")]).nextState;
    const id = state.intelItems[0].id;
    state = updateIntelItemStatus(state, id, "ignored");
    expect(state.intelItems.find((entry) => entry.id === id)?.status).toBe("ignored");
  });

  it("promotes an item to a knowledge debt and marks it saved", () => {
    let state = createInitialProductState();
    const created = createIntelTask(state, { name: "T", keywords: ["a"] });
    state = ingestIntelItems(created.nextState, created.task, [
      item("https://e.com/3", { title: "Important trend", claims: ["c1"] })
    ]).nextState;
    const id = state.intelItems[0].id;
    const debtCountBefore = state.debts.length;

    const { debt, nextState } = intelItemToKnowledgeDebt(state, id);
    expect(debt).toBeDefined();
    expect(nextState.debts.length).toBe(debtCountBefore + 1);
    expect(nextState.intelItems.find((entry) => entry.id === id)?.status).toBe("saved");
  });
});
