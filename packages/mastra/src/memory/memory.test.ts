import { describe, it, expect, vi } from "vitest";

vi.mock("@mastra/memory", () => ({
  Memory: vi.fn().mockImplementation((config: any) => ({
    config,
    id: "mock-memory",
  })),
}));

describe("memory config", () => {
  it("workingMemory is defined", async () => {
    const { workingMemory } = await import("./workingMemory");
    expect(workingMemory).toBeDefined();
  });

  it("semanticMemory is defined", async () => {
    const { semanticMemory } = await import("./semanticRecall");
    expect(semanticMemory).toBeDefined();
  });
});
