import { describe, it, expect, vi } from "vitest";

vi.mock("@mastra/memory", () => {
  class MockMemory {
    config: any;
    id: string;
    constructor(config: any) {
      this.config = config;
      this.id = "mock-memory";
    }
  }
  return { Memory: MockMemory };
});

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
