import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const dir = join(dirname(fileURLToPath(import.meta.url)), "../scenarios");

function load(name: string) {
  return JSON.parse(readFileSync(join(dir, name), "utf8"));
}

describe("frozen packs", () => {
  it("smoke pack is the three ADV scenarios", () => {
    const pack = load("pack.smoke.json");
    expect(pack.ids).toEqual(["ADV-short-abstract", "ADV-short-shame-dns", "ADV-control-six"]);
    expect(pack.maxHostCalls).toBe(50);
  });

  it("full pack lists CLOCK + FLOW-memory S1b blocked:true contract, not second-approve", () => {
    const pack = load("pack.full.json");
    expect(pack.ids).toContain("CLOCK-debt");
    expect(pack.ids).toContain("CLOCK-decision");
    expect(pack.ids).toContain("CLOCK-contradiction");
    expect(pack.ids).toContain("CLOCK-blindspot");
    expect(pack.ids).toContain("FLOW-memory");
    expect(pack.ids).toContain("ADV-insight-tension");
    expect(pack.ids).toContain("ADV-turn15");
    const flow = load("FLOW-memory.json");
    expect(flow.s1b.expectBlocked).toBe(true);
    expect(flow.s1b.expectStatus).toBe(409);
    expect(flow.s1b.force).toBe(false);
    expect(flow.s1b.suggestedUpdate).toBe("conflict");
    expect(flow.s1b.notSecondApprove).toBe(true);
  });
});
