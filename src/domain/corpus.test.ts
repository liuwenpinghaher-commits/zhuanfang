import { describe, expect, it } from "vitest";
import { analyzeImportedInterview, approvePlaybookPatch, createInitialProductState } from "./engine";

// S3-B (producer side): the deterministic corpus analyzer must stamp ruleType onto
// the rules it generates, so strategy routing no longer relies on brittle keyword text.

describe("analyzeImportedInterview — ruleType stamping (deterministic path)", () => {
  it("assigns concrete-moment / mechanism-reversal ruleTypes to default template rules", () => {
    const state = createInitialProductState();
    const { insight } = analyzeImportedInterview(state, {
      title: "优秀样本",
      content: "主持人：能说一个最近的具体时刻吗？\n受访者：上周开会时我没敢拍板。",
      mediaType: "text"
    });
    const patch = insight.recommendedPatches[0];
    expect(patch).toBeDefined();
    // The default deterministic patch carries two technique rules; both must be typed.
    expect(patch.ruleTypes).toBeDefined();
    expect(patch.ruleTypes).toContain("concrete-moment");
    expect(patch.ruleTypes).toContain("mechanism-reversal");
    // ruleTypes is positionally aligned with rules.
    expect(patch.ruleTypes!.length).toBe(patch.rules.length);
  });

  it("infers ruleType from LLM-supplied rule text when the analysis omits explicit types", () => {
    const state = createInitialProductState();
    const { insight } = analyzeImportedInterview(
      state,
      { title: "LLM 样本", content: "主持人：…", mediaType: "text" },
      {
        dimensions: [
          { name: "追问动作", score: 4, finding: "好", example: "原话", recommendedAction: "学" }
        ],
        improvementPlan: [
          { title: "改进", rationale: "因为", action: "怎么做", expectedEngineChange: "会变", evidence: "原话" }
        ],
        patch: {
          title: "补丁",
          description: "说明",
          rules: [
            "抽象评价先落到一个具体时刻再追问。",
            "拿到例子后从机制、奖励和代价反问。",
            "保持单步节奏。"
          ],
          impact: "medium"
        }
      }
    );
    const patch = insight.recommendedPatches[0];
    expect(patch.ruleTypes).toBeDefined();
    expect(patch.ruleTypes!.length).toBe(patch.rules.length);
    expect(patch.ruleTypes![0]).toBe("concrete-moment");
    expect(patch.ruleTypes![1]).toBe("mechanism-reversal");
  });
});

// C3: users can edit the recommended patch rules before approving them into the
// engine. approvePlaybookPatch gains an optional overrideRules parameter that, when
// supplied, replaces the rules and re-derives ruleTypes — while staying backward
// compatible when omitted.

describe("approvePlaybookPatch — editable rules before apply (C3)", () => {
  function seedProposedPatch() {
    const state = analyzeImportedInterview(createInitialProductState(), {
      title: "样本",
      content: "主持人：能说一个最近的具体时刻吗？\n受访者：上周开会时我没敢拍板。",
      mediaType: "text"
    }).nextState;
    const patch = state.playbookPatches[0];
    return { state, patchId: patch.id, originalRules: patch.rules };
  }

  it("applies the original rules unchanged when no overrideRules are passed (backward compatible)", () => {
    const { state, patchId, originalRules } = seedProposedPatch();
    const next = approvePlaybookPatch(state, patchId);
    const applied = next.playbookPatches.find((item) => item.id === patchId);
    expect(applied?.status).toBe("applied");
    expect(applied?.rules).toEqual(originalRules);
  });

  it("replaces rules with overrideRules and re-derives ruleTypes from the edited text", () => {
    const { state, patchId } = seedProposedPatch();
    const edited = [
      "抽象评价先落到一个具体时刻再追问。",
      "拿到例子后从机制、奖励和代价反问。"
    ];
    const next = approvePlaybookPatch(state, patchId, edited);
    const applied = next.playbookPatches.find((item) => item.id === patchId);
    expect(applied?.status).toBe("applied");
    expect(applied?.rules).toEqual(edited);
    // ruleTypes are re-classified positionally from the edited rules, not the originals.
    expect(applied?.ruleTypes).toEqual(["concrete-moment", "mechanism-reversal"]);
    expect(applied?.ruleTypes!.length).toBe(edited.length);
  });

  it("also reflects the edited rules on the insight's recommendedPatches copy", () => {
    const { state, patchId } = seedProposedPatch();
    const edited = ["只问一个具体场景，再追问。"];
    const next = approvePlaybookPatch(state, patchId, edited);
    const insightPatch = next.corpusInsights
      .flatMap((insight) => insight.recommendedPatches)
      .find((item) => item.id === patchId);
    expect(insightPatch?.rules).toEqual(edited);
    expect(insightPatch?.ruleTypes).toEqual(["concrete-moment"]);
  });

  it("treats an empty overrideRules array as 'no override' and keeps the original rules", () => {
    const { state, patchId, originalRules } = seedProposedPatch();
    const next = approvePlaybookPatch(state, patchId, []);
    const applied = next.playbookPatches.find((item) => item.id === patchId);
    expect(applied?.status).toBe("applied");
    expect(applied?.rules).toEqual(originalRules);
  });

  it("drops blank entries from overrideRules before applying", () => {
    const { state, patchId } = seedProposedPatch();
    const next = approvePlaybookPatch(state, patchId, ["  ", "保持单步节奏。", ""]);
    const applied = next.playbookPatches.find((item) => item.id === patchId);
    expect(applied?.rules).toEqual(["保持单步节奏。"]);
  });
});
