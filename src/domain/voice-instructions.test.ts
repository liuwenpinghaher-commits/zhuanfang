import { describe, expect, it } from "vitest";
import { buildRealtimeVoiceInstructions, buildBoundariesBlock } from "./voice-instructions";
import { createInitialProductState, createSessionDraft, createEmptyProductState } from "./engine";

describe("explicit boundaries reach the interviewer prompt (P1)", () => {
  it("buildBoundariesBlock renders a hard, non-negotiable directive listing each boundary", () => {
    expect(buildBoundariesBlock([])).toBe("");
    expect(buildBoundariesBlock(["   "])).toBe(""); // blanks ignored
    const block = buildBoundariesBlock(["不要追问家庭关系", "不要把情绪写成人格结论"]);
    expect(block).toContain("绝不违反");
    expect(block).toContain("不要追问家庭关系");
    expect(block).toContain("不要把情绪写成人格结论");
  });

  it("buildRealtimeVoiceInstructions injects the user's boundaries so the voice path enforces them", () => {
    const session = createSessionDraft(createInitialProductState(), "decision", "standard", {});
    const out = buildRealtimeVoiceInstructions(session, session.card, [], ["不要追问家庭关系"]);
    expect(out).toContain("不要追问家庭关系");
    expect(out).toContain("绝不违反");
  });
});

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

  // S3-A: playbook rules (enginePolicy.appliedPlaybookRules) must reach the realtime voice prompt.
  it("injects applied playbook rules from enginePolicy into the voice instructions", () => {
    const state = createInitialProductState();
    const session = createSessionDraft(state, "decision", "standard", {});
    session.enginePolicy = {
      ...session.enginePolicy!,
      appliedPlaybookRules: [
        "当用户使用抽象评价时，先追问一个具体时刻。",
        "当用户已经给出具体例子后，再从机制、奖励和代价角度反问。",
        "每轮只改变一个追问动作。"
      ]
    };
    const out = buildRealtimeVoiceInstructions(session, session.card);
    expect(out).toContain("已应用的提问技法");
    expect(out).toContain("先追问一个具体时刻");
    expect(out).toContain("从机制、奖励和代价角度反问");
  });

  it("caps injected playbook rules at 3 and omits the section when there are none", () => {
    const state = createInitialProductState();
    const session = createSessionDraft(state, "decision", "standard", {});

    // No applied rules → no section, no crash.
    session.enginePolicy = { ...session.enginePolicy!, appliedPlaybookRules: [] };
    const empty = buildRealtimeVoiceInstructions(session, session.card);
    expect(empty).not.toContain("已应用的提问技法");

    // More than 3 rules → only the first 3 surface.
    session.enginePolicy = {
      ...session.enginePolicy!,
      appliedPlaybookRules: ["规则甲", "规则乙", "规则丙", "规则丁不应出现"]
    };
    const capped = buildRealtimeVoiceInstructions(session, session.card);
    expect(capped).toContain("规则甲");
    expect(capped).toContain("规则丙");
    expect(capped).not.toContain("规则丁不应出现");
  });

  // S3-C: most-recent memoryCorrections must reach the realtime voice prompt (bounded ≤10).
  it("injects the most recent memory corrections (bounded at 10) into the voice instructions", () => {
    const state = createInitialProductState();
    const session = createSessionDraft(state, "decision", "standard", {});
    const corrections = Array.from({ length: 12 }, (_, i) => ({
      id: `corr-${i + 1}`,
      text: `用户纠正${i + 1}`,
      createdAt: new Date(Date.UTC(2026, 0, i + 1)).toISOString()
    }));
    const out = buildRealtimeVoiceInstructions(session, session.card, corrections);
    expect(out).toContain("用户已纠正过的表述");
    // newest (day 12) present, oldest two (day 1, day 2) dropped by the ≤10 bound
    expect(out).toContain("用户纠正12");
    expect(out).not.toContain("用户纠正1。");
    expect(out).not.toContain("用户纠正2。");
  });

  it("omits the corrections section when there are no corrections and does not crash", () => {
    const state = createInitialProductState();
    const session = createSessionDraft(state, "decision", "standard", {});
    expect(() => buildRealtimeVoiceInstructions(session, session.card, [])).not.toThrow();
    const out = buildRealtimeVoiceInstructions(session, session.card, []);
    expect(out).not.toContain("用户已纠正过的表述");
  });
});
