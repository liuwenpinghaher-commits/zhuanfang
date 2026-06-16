import { describe, expect, it } from "vitest";
import { buildRealtimeVoiceInstructions } from "./voice-instructions";
import { createInitialProductState, createSessionDraft, createEmptyProductState } from "./engine";

describe("voice instructions", () => {
  it("includes opening discipline, craft rules, and guide tracking-points", () => {
    const state = createInitialProductState();
    const session = createSessionDraft(state, "decision", "standard", {});
    const out = buildRealtimeVoiceInstructions(session, session.card);
    expect(out).toContain("【开场铁律");
    expect(out).toMatch(/你好吗|最近怎么样|刚来/);     // bans small-talk/meta
    expect(out).toContain(session.card.suggestedOpening);
    expect(out).toContain("每次只问一个核心问题");      // shared craft
    expect(out).toContain("二选一");
    expect(out).toMatch(/历史|立场|知识债|盲区/);       // tracking-points (thin copy dropped these)
  });
  it("does not crash on an empty (clean-start) session", () => {
    const session = createSessionDraft(createEmptyProductState(), "decision", "standard", {});
    expect(() => buildRealtimeVoiceInstructions(session, session.card)).not.toThrow();
  });
});
