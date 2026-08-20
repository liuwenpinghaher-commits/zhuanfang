import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { guestReply, matchBehavior } from "./guest-simulator.mjs";

const scenarioDir = join(dirname(fileURLToPath(import.meta.url)), "../scenarios");

/** Design-order overlapping list: range first, then exact shame/dns. First-match would fail. */
const DESIGN_ORDER_OVERLAPPING = [
  { at: "turn>=1", kind: "short_answer", maxChars: 40 },
  { at: "turn==0", kind: "short_answer", maxChars: 40, text: "最近工作压力大，不想展开。" },
  { at: "turn==4", kind: "shame_contract", text: "这个……算了不说了。" },
  { at: "turn==7", kind: "do_not_write", text: "刚才那段别写进档案。" }
];

describe("matchBehavior (shipped) overlapping at", () => {
  it("turn 4 is shame_contract and turn 7 is do_not_write when range is listed first", () => {
    expect(matchBehavior(DESIGN_ORDER_OVERLAPPING, 4)?.kind).toBe("shame_contract");
    expect(matchBehavior(DESIGN_ORDER_OVERLAPPING, 7)?.kind).toBe("do_not_write");
    expect(matchBehavior(DESIGN_ORDER_OVERLAPPING, 1)?.kind).toBe("short_answer");
    expect(matchBehavior(DESIGN_ORDER_OVERLAPPING, 5)?.kind).toBe("short_answer");
    expect(matchBehavior(DESIGN_ORDER_OVERLAPPING, 0)?.kind).toBe("short_answer");
  });

  it("ADV-short-shame-dns.json binds the same way (guestReply uses shipped matchBehavior)", async () => {
    const scenario = JSON.parse(readFileSync(join(scenarioDir, "ADV-short-shame-dns.json"), "utf8"));
    expect(scenario.guest.behaviors[0].at).toBe("turn>=1");
    const t4 = await guestReply({ scenario, turnIndex: 4, env: {}, guestCalls: { count: 0 } });
    const t7 = await guestReply({ scenario, turnIndex: 7, env: {}, guestCalls: { count: 0 } });
    const t2 = await guestReply({ scenario, turnIndex: 2, env: {}, guestCalls: { count: 0 } });
    expect(t4.behavior?.kind).toBe("shame_contract");
    expect(t4.text).toBe("这个……算了不说了。");
    expect(t7.behavior?.kind).toBe("do_not_write");
    expect(t7.text).toBe("刚才那段别写进档案。");
    expect(t2.behavior?.kind).toBe("short_answer");
    expect(t4.via).toBe("script");
    expect(t7.via).toBe("script");
  });
});
