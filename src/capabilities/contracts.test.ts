import { describe, expect, it } from "vitest";
import { searchProviderLabels } from "./contracts";

describe("capability contracts", () => {
  it("labels search provider ids used by configuration and task feedback", () => {
    expect(searchProviderLabels["local-demo"]).toBe("Local Demo Search");
    expect(searchProviderLabels.bailian).toBe("百炼内置联网");
    expect(searchProviderLabels.anysearch).toBe("AnySearch");
    expect(Object.keys(searchProviderLabels)).toEqual(["local-demo", "bailian", "anysearch"]);
  });
});
