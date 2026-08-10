import { afterEach, describe, expect, it } from "vitest";
import {
  INTERVIEW_RUBRIC_DIMENSIONS,
  VOICE_CRAFT_OUTPUT_GUARD_ENV,
  applyCraftOutputGuard,
  assessAssistantCraftOutput,
  buildCraftMetaFromGuardResult,
  emptyTurn15TrackingHook,
  isCraftOutputGuardEnabled,
  looksLikeMultiQuestion,
  sumInterviewRubricScores,
  truncateToFirstQuestion
} from "./craft-output-guard";

describe("isCraftOutputGuardEnabled", () => {
  const prev = process.env[VOICE_CRAFT_OUTPUT_GUARD_ENV];
  afterEach(() => {
    if (prev === undefined) delete process.env[VOICE_CRAFT_OUTPUT_GUARD_ENV];
    else process.env[VOICE_CRAFT_OUTPUT_GUARD_ENV] = prev;
  });

  it("defaults OFF when unset or empty", () => {
    expect(isCraftOutputGuardEnabled({})).toBe(false);
    expect(isCraftOutputGuardEnabled({ [VOICE_CRAFT_OUTPUT_GUARD_ENV]: "" })).toBe(false);
    expect(isCraftOutputGuardEnabled({ [VOICE_CRAFT_OUTPUT_GUARD_ENV]: "   " })).toBe(false);
  });

  it("is true only for explicit truthy tokens", () => {
    expect(isCraftOutputGuardEnabled({ [VOICE_CRAFT_OUTPUT_GUARD_ENV]: "true" })).toBe(true);
    expect(isCraftOutputGuardEnabled({ [VOICE_CRAFT_OUTPUT_GUARD_ENV]: "1" })).toBe(true);
    expect(isCraftOutputGuardEnabled({ [VOICE_CRAFT_OUTPUT_GUARD_ENV]: "YES" })).toBe(true);
    expect(isCraftOutputGuardEnabled({ [VOICE_CRAFT_OUTPUT_GUARD_ENV]: "on" })).toBe(true);
    expect(isCraftOutputGuardEnabled({ [VOICE_CRAFT_OUTPUT_GUARD_ENV]: "false" })).toBe(false);
    expect(isCraftOutputGuardEnabled({ [VOICE_CRAFT_OUTPUT_GUARD_ENV]: "0" })).toBe(false);
  });
});

describe("assess / multi-question heuristics", () => {
  it("flags double question marks as multi-question", () => {
    const text = "最近一次是什么时候？当时谁在场？";
    expect(looksLikeMultiQuestion(text)).toBe(true);
    const a = assessAssistantCraftOutput(text);
    expect(a.multiQuestion).toBe(true);
    expect(a.singleQuestionHeuristicOk).toBe(false);
    expect(a.reasons).toContain("multi_question");
  });

  it("accepts a single short probe", () => {
    const text = "最近一次具体是哪一天？";
    expect(looksLikeMultiQuestion(text)).toBe(false);
    const a = assessAssistantCraftOutput(text);
    expect(a.singleQuestionHeuristicOk).toBe(true);
    expect(a.reasons).toEqual([]);
  });

  it("flags counselor anti-pattern phrases", () => {
    const text =
      "你提到了放权，这听起来很关键，那在这个过程中有没有遇到过什么挑战呢？";
    const a = assessAssistantCraftOutput(text);
    expect(a.counselorPattern).toBe(true);
    expect(a.reasons).toContain("counselor_pattern");
  });
});

describe("truncateToFirstQuestion", () => {
  it("keeps only the first question", () => {
    expect(truncateToFirstQuestion("A？B？")).toBe("A？");
    expect(truncateToFirstQuestion("先问这个？再问那个？还有第三个。")).toBe("先问这个？");
  });

  it("does not return empty for non-empty input", () => {
    expect(truncateToFirstQuestion("没有问号的长句").length).toBeGreaterThan(0);
  });
});

describe("applyCraftOutputGuard", () => {
  it("passthrough when disabled (default) even if multi-question", () => {
    const text = "第一问？第二问？";
    const r = applyCraftOutputGuard(text, { enabled: false });
    expect(r.enabled).toBe(false);
    expect(r.action).toBe("passthrough");
    expect(r.outputGuardTriggered).toBe(false);
    expect(r.text).toBe(text);
    expect(r.reasons).toContain("multi_question");
  });

  it("truncates multi-question when enabled", () => {
    const text = "最近一次是什么时候？当时谁在场？";
    const r = applyCraftOutputGuard(text, { enabled: true });
    expect(r.action).toBe("truncated");
    expect(r.outputGuardTriggered).toBe(true);
    expect(r.text).toBe("最近一次是什么时候？");
    expect(r.singleQuestionHeuristicOk).toBe(false);
    const meta = buildCraftMetaFromGuardResult(r);
    expect(meta.outputGuardTriggered).toBe(true);
    expect(meta.action).toBe("truncated");
  });

  it("retry_logged for counselor-only when enabled without multi-q rewrite", () => {
    // Single question mark so multi_question may still fire on counselor phrasing —
    // pick a single-? counselor line if possible.
    const text = "你提到了放权，这听起来很重要。";
    const r = applyCraftOutputGuard(text, { enabled: true });
    expect(r.outputGuardTriggered).toBe(true);
    expect(r.action).toBe("retry_logged");
    expect(r.text).toBe(text);
  });

  it("reads env when enabled option omitted", () => {
    const text = "一？二？";
    const off = applyCraftOutputGuard(text, {
      env: { [VOICE_CRAFT_OUTPUT_GUARD_ENV]: "false" }
    });
    expect(off.action).toBe("passthrough");
    const on = applyCraftOutputGuard(text, {
      env: { [VOICE_CRAFT_OUTPUT_GUARD_ENV]: "true" }
    });
    expect(on.action).toBe("truncated");
    expect(on.text).toBe("一？");
  });
});

describe("rubric hooks", () => {
  it("exposes five dimensions and turn-15 empty hook", () => {
    expect(INTERVIEW_RUBRIC_DIMENSIONS).toHaveLength(5);
    const hook = emptyTurn15TrackingHook("manual sample");
    expect(hook.turnIndex).toBe(15);
    expect(hook.trackingOk).toBeNull();
    expect(
      sumInterviewRubricScores({
        concrete_moment: 2,
        single_question: 2,
        no_advice_list: 1,
        no_fabricated_memory: 2,
        strategy_alignment: 1
      })
    ).toBe(8);
  });
});
