import { describe, expect, it } from "vitest";
import { createInitialProductState } from "./engine";
import { createIntelTask, ingestIntelItems, intelItemToKnowledgeDebt, isIntelTaskDue, updateIntelItemStatus } from "./intel";

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

describe("isIntelTaskDue", () => {
  const base = {
    id: "t",
    name: "n",
    keywords: ["a"],
    provider: "bailian" as const,
    relatedThemeIds: [],
    relatedDebtIds: [],
    status: "active" as const,
    createdAt: "2026-06-01T00:00:00.000Z"
  };
  const now = new Date("2026-06-15T00:00:00.000Z");

  it("manual frequency is never due", () => {
    expect(isIntelTaskDue({ ...base, frequency: "manual" }, now)).toBe(false);
  });

  it("daily due when lastRunAt > 1 day ago", () => {
    expect(isIntelTaskDue({ ...base, frequency: "daily", lastRunAt: "2026-06-13T00:00:00.000Z" }, now)).toBe(true);
  });

  it("daily not due when lastRunAt < 1 day ago", () => {
    expect(
      isIntelTaskDue(
        { ...base, frequency: "daily", lastRunAt: "2026-06-15T01:00:00.000Z" },
        new Date("2026-06-15T02:00:00.000Z")
      )
    ).toBe(false);
  });

  it("weekly due when lastRunAt > 7 days ago", () => {
    expect(isIntelTaskDue({ ...base, frequency: "weekly", lastRunAt: "2026-06-01T00:00:00.000Z" }, now)).toBe(true);
  });

  it("no lastRunAt → due for non-manual frequency", () => {
    expect(isIntelTaskDue({ ...base, frequency: "daily" }, now)).toBe(true);
  });

  it("paused status is never due", () => {
    expect(isIntelTaskDue({ ...base, frequency: "daily", status: "paused" }, now)).toBe(false);
  });
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
