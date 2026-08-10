import { describe, expect, it } from "vitest";
import {
  assertAllCraftGoldenPass,
  runAllCraftGolden,
  runConcreteMomentScenario,
  runContradictionReviewScenario,
  runDebtFollowupNoDuplicateScenario,
  runDecisionOverPlaybookFollowupScenario,
  runDecisionReviewOnceScenario,
  runPlaybookFollowupOverSynthesisScenario,
  runPlaybookFollowupProbeScenario,
  runRagGroundingRefuseScenario
} from "./craft-golden";

describe("craft golden factory (shipped strategy/retrieval)", () => {
  it("runs all rubric-aligned scenarios against real domain paths", () => {
    const results = runAllCraftGolden();
    expect(results).toHaveLength(8);
    expect(results.map((r) => r.id).sort()).toEqual(
      [
        "concrete_moment_probe",
        "contradiction_review_mid_late_once",
        "debt_followup_no_duplicate",
        "decision_over_playbook_followup",
        "decision_review_once",
        "playbook_followup_over_synthesis",
        "playbook_followup_probe",
        "rag_grounding_refuse"
      ].sort()
    );
    assertAllCraftGoldenPass(results);
  });

  it("concrete_moment_probe", () => {
    expect(runConcreteMomentScenario().pass).toBe(true);
  });

  it("decision_review_once", () => {
    expect(runDecisionReviewOnceScenario().pass).toBe(true);
  });

  it("debt_followup_no_duplicate", () => {
    expect(runDebtFollowupNoDuplicateScenario().pass).toBe(true);
  });

  it("contradiction_review_mid_late_once (produce contradicts + consume)", () => {
    expect(runContradictionReviewScenario().pass).toBe(true);
  });

  it("rag_grounding_refuse", () => {
    expect(runRagGroundingRefuseScenario().pass).toBe(true);
  });

  it("playbook_followup_probe", () => {
    expect(runPlaybookFollowupProbeScenario().pass).toBe(true);
  });

  it("decision_over_playbook_followup", () => {
    expect(runDecisionOverPlaybookFollowupScenario().pass).toBe(true);
  });

  it("playbook_followup_over_synthesis", () => {
    expect(runPlaybookFollowupOverSynthesisScenario().pass).toBe(true);
  });
});
