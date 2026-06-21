import { describe, it, expect } from "vitest";
import {
  updateProfile,
  addExplicitBoundary,
  removeExplicitBoundary,
  addProfileSuggestions,
  approveProfileSuggestion,
  rejectProfileSuggestion
} from "./profile";
import { createInitialProductState } from "./engine";

describe("profile self-learning suggestions (P0b — HITL)", () => {
  const suggestion = {
    field: "currentFocus" as const,
    suggestedValue: "把语音专访做成长期认知产品",
    reason: "用户多次提到要从 demo 转向长期可用",
    evidenceQuote: "我现在最想的是把它做成能长期用的东西"
  };

  it("addProfileSuggestions appends pending suggestions with a snapshot of the current value", () => {
    const state = createInitialProductState();
    const next = addProfileSuggestions(state, [suggestion], "s1", "2026-06-21T00:00:00.000Z");
    expect(next.profileSuggestions).toHaveLength(1);
    const s = next.profileSuggestions[0];
    expect(s.status).toBe("pending");
    expect(s.field).toBe("currentFocus");
    expect(s.currentValue).toBe(state.profile.currentFocus);
    expect(s.suggestedValue).toBe("把语音专访做成长期认知产品");
    expect(s.sourceSessionId).toBe("s1");
    expect(next.auditEvents.some((e) => e.type === "profile_suggestion_created")).toBe(true);
  });

  it("skips a no-op (suggested === current) and blank suggestions", () => {
    const state = createInitialProductState();
    const same = { ...suggestion, suggestedValue: state.profile.currentFocus };
    expect(addProfileSuggestions(state, [same], "s1", "t").profileSuggestions).toHaveLength(0);
    const blank = { ...suggestion, suggestedValue: "   " };
    expect(addProfileSuggestions(state, [blank], "s1", "t").profileSuggestions).toHaveLength(0);
  });

  it("approveProfileSuggestion applies the suggested value to the profile and marks approved", () => {
    const withSug = addProfileSuggestions(createInitialProductState(), [suggestion], "s1", "t");
    const id = withSug.profileSuggestions[0].id;
    const approved = approveProfileSuggestion(withSug, id);
    expect(approved.profile.currentFocus).toBe("把语音专访做成长期认知产品");
    expect(approved.profileSuggestions[0].status).toBe("approved");
    expect(approved.auditEvents.some((e) => e.type === "profile_suggestion_approved")).toBe(true);
  });

  it("rejectProfileSuggestion marks rejected WITHOUT touching the profile", () => {
    const withSug = addProfileSuggestions(createInitialProductState(), [suggestion], "s1", "t");
    const focusBefore = withSug.profile.currentFocus;
    const rejected = rejectProfileSuggestion(withSug, withSug.profileSuggestions[0].id);
    expect(rejected.profile.currentFocus).toBe(focusBefore);
    expect(rejected.profileSuggestions[0].status).toBe("rejected");
  });

  it("approve/reject are no-ops on a missing or already-reviewed id", () => {
    const state = createInitialProductState();
    expect(approveProfileSuggestion(state, "nope")).toBe(state);
    const withSug = addProfileSuggestions(state, [suggestion], "s1", "t");
    const approved = approveProfileSuggestion(withSug, withSug.profileSuggestions[0].id);
    expect(approveProfileSuggestion(approved, withSug.profileSuggestions[0].id)).toBe(approved);
  });
});

describe("updateProfile (P0a — make 显性档案 fillable)", () => {
  it("updates editable identity/focus fields and trims whitespace", () => {
    const state = createInitialProductState();
    const next = updateProfile(state, {
      name: "  Mia  ",
      currentFocus: " 把 demo 做成长期产品 ",
      preferredStrength: "sharp"
    });
    expect(next.profile.name).toBe("Mia");
    expect(next.profile.currentFocus).toBe("把 demo 做成长期产品");
    expect(next.profile.preferredStrength).toBe("sharp");
  });

  it("applies a partial patch (undefined fields untouched) and ignores an invalid strength", () => {
    const state = createInitialProductState();
    const goalBefore = state.profile.longTermGoal;
    const strengthBefore = state.profile.preferredStrength;
    const next = updateProfile(state, { role: "产品负责人", preferredStrength: "bogus" as never });
    expect(next.profile.role).toBe("产品负责人");
    expect(next.profile.longTermGoal).toBe(goalBefore); // untouched
    expect(next.profile.preferredStrength).toBe(strengthBefore); // invalid value rejected
  });

  it("does not mutate the input state and records a profile_updated audit event", () => {
    const state = createInitialProductState();
    const origName = state.profile.name;
    const next = updateProfile(state, { name: "Changed" });
    expect(state.profile.name).toBe(origName); // immutability
    expect(next.auditEvents.some((e) => e.type === "profile_updated")).toBe(true);
  });
});

describe("explicit boundaries (P1 — make 用户边界 real & writable)", () => {
  it("adds a trimmed boundary newest-first, ignoring blanks and duplicates", () => {
    const state = createInitialProductState();
    const added = addExplicitBoundary(state, "  不要追问家庭关系  ");
    expect(added.profile.explicitBoundaries[0]).toBe("不要追问家庭关系");

    const blank = addExplicitBoundary(added, "   ");
    expect(blank.profile.explicitBoundaries.length).toBe(added.profile.explicitBoundaries.length);

    const dupe = addExplicitBoundary(added, "不要追问家庭关系");
    expect(dupe.profile.explicitBoundaries.length).toBe(added.profile.explicitBoundaries.length);
  });

  it("removes a boundary by exact text", () => {
    const state = createInitialProductState();
    let next = addExplicitBoundary(state, "边界A");
    next = addExplicitBoundary(next, "边界B");
    const removed = removeExplicitBoundary(next, "边界A");
    expect(removed.profile.explicitBoundaries).not.toContain("边界A");
    expect(removed.profile.explicitBoundaries).toContain("边界B");
  });

  it("does not mutate the input state and records an audit event", () => {
    const state = createInitialProductState();
    const next = addExplicitBoundary(state, "边界X");
    expect(state.profile.explicitBoundaries).not.toContain("边界X");
    expect(next.auditEvents.some((e) => e.type === "profile_updated")).toBe(true);
  });
});
