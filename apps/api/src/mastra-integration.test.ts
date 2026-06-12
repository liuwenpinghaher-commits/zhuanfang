import { describe, it, expect } from "vitest";
import { createMastraIntegration } from "./mastra-integration";
import { createInMemoryProductStateRepository } from "./product-state-repository";
import { createInitialProductState } from "../../../src/domain/engine";

describe("mastra-integration", () => {
  const stateRepo = createInMemoryProductStateRepository(createInitialProductState());
  const mastra = createMastraIntegration(stateRepo);

  it("returns 10 agent names", () => {
    const names = mastra.getAgentNames();
    expect(names.length).toBe(10);
    expect(names).toContain("interviewDirector");
  });

  it("returns 12 workflow names", () => {
    const names = mastra.getWorkflowNames();
    expect(names.length).toBe(12);
    expect(names).toContain("interview-preparation");
  });

  it("gracefully degrades when Mastra is unavailable", async () => {
    const result = await mastra.runWorkflow("interview-preparation", { mode: "daily" });
    expect(result).toHaveProperty("degraded", true);
    expect(result).toHaveProperty("reason", "mastra-unavailable");
  });
});
