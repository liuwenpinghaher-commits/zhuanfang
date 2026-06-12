import { describe, expect, it } from "vitest";
import { createSearchBriefFromInput, createInitialProductState } from "../domain/engine";
import { executeSearchProvider, getSearchProvider } from "./search";

describe("search capability providers", () => {
  it("runs the local demo search provider and creates a search brief", async () => {
    const state = createInitialProductState();

    const run = await executeSearchProvider({
      topic: "AI 产品商业化热点",
      providerId: "local-demo",
      maxSources: 4,
      recencyDays: 14
    });
    const { brief, nextState } = createSearchBriefFromInput(state, run.result);

    expect(run.task.status).toBe("succeeded");
    expect(run.result.provider).toBe("local-demo");
    expect(run.result.sources).toHaveLength(4);
    expect(run.result.facts.length).toBeGreaterThan(0);
    expect(run.result.controversies.length).toBeGreaterThan(0);
    expect(run.result.opposingViews.length).toBeGreaterThan(0);
    expect(run.result.interviewAngles.length).toBeGreaterThan(0);
    expect(brief.provider).toBe("local-demo");
    expect(nextState.searchBriefs[0].id).toBe(brief.id);
  });

  it("uses an AnySearch shell as degraded output when no real connector is configured", async () => {
    const provider = getSearchProvider("anysearch");
    const run = await executeSearchProvider({
      topic: "AI 产品商业化热点",
      providerId: "anysearch",
      maxSources: 3,
      recencyDays: 7
    });

    expect(provider.label).toBe("AnySearch");
    expect(run.task.status).toBe("degraded");
    expect(run.task.degradedReason).toContain("API key");
    expect(run.result.status).toBe("needs-review");
    expect(run.result.sources[0].publisher).toBe("AnySearch");
  });
});
