import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assessVoiceBook } from "./voice-book.mjs";

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

  it("voice scenarios use a human topic, not the scene id", () => {
    for (const id of ["VOICE-echo", "VOICE-endpoint", "VOICE-barge"]) {
      const scene = load(`${id}.json`);
      expect(scene.topicHint).toBe("授权那次救火");
      expect(scene.topicHint).not.toBe(scene.id);
    }
    expect(load("VOICE-barge.json").guest.behaviors).toHaveLength(2);
  });

  it("voice book fails doubled user talk and a host that only says 好你说", () => {
    const scenario = load("VOICE-echo.json");
    const bad = assessVoiceBook({
      scenario,
      session: { title: "继续追问：VOICE-echo" },
      turns: [
        { role: "user", content: "我讲完这一句就不补了，我讲完这一句就不补了。" },
        { role: "assistant", content: "好，你说。" }
      ],
      voice: { echoSpokeEarly: false }
    });
    expect(bad.pass).toBe(false);
    expect(bad.doubled).toBe(true);
    const good = assessVoiceBook({
      scenario,
      session: { title: "日常复盘：授权那次救火" },
      turns: [
        { role: "user", content: "我先说一句：授权让我最难受的是那次救火。" },
        { role: "assistant", content: "那次救火现场，是谁做的决定？" }
      ],
      voice: { echoSpokeEarly: true, echoCreatedTurn: false }
    });
    expect(good.pass).toBe(true);
  });
});
