import { describe, expect, it } from "vitest";
import {
  buildInterruptedStash,
  formatInterruptedStashForPrompt,
  consumeStashAfterUse
} from "./voice-interrupt-stash";

describe("voice-interrupt-stash", () => {
  it("builds stash only for non-empty spoken text", () => {
    expect(buildInterruptedStash("  ")).toBeNull();
    const s = buildInterruptedStash("你的账户余额是…", { sessionId: "s1" });
    expect(s?.text).toContain("余额");
    expect(s?.sessionId).toBe("s1");
  });

  it("formats prompt and consumes after use", () => {
    const s = buildInterruptedStash("先说重点");
    const line = formatInterruptedStashForPrompt(s);
    expect(line).toContain("打断上下文");
    expect(line).toContain("先说重点");
    expect(consumeStashAfterUse(s)).toBeNull();
  });
});
