import { describe, it, expect } from "vitest";

describe("Mastra package structure", () => {
  it("should export mastra from index", async () => {
    const mod = await import("./index");
    expect(mod.mastra).toBeDefined();
  });

  it("should have mastra.config module", async () => {
    const mod = await import("./mastra.config");
    expect(mod.mastra).toBeDefined();
  });
});
