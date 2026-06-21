import type {
  InterviewStrength,
  ProductState,
  ProfileSuggestion,
  ProfileSuggestionField,
  UserProfile
} from "./types";
import { cloneState, makeId, nowIso, withAuditEvent } from "./utils";

/** Fields the user may edit from the 个人档案 UI — identity plus the inputs that actually
 *  shape interviews (currentFocus / longTermGoal / preferredStrength feed the guide & prompt). */
export type EditableProfileFields = Pick<
  UserProfile,
  "name" | "role" | "industry" | "currentFocus" | "longTermGoal" | "preferredStrength"
>;

const VALID_STRENGTHS: InterviewStrength[] = ["gentle", "standard", "sharp"];
type TextProfileField = "name" | "role" | "industry" | "currentFocus" | "longTermGoal";
const TEXT_FIELDS: TextProfileField[] = ["name", "role", "industry", "currentFocus", "longTermGoal"];

function auditProfile(state: ProductState, profile: UserProfile, label: string, detail: string): ProductState {
  const createdAt = nowIso();
  return withAuditEvent(
    { ...state, profile },
    {
      type: "profile_updated",
      label,
      detail,
      severity: "info",
      entityType: "user_profile",
      entityId: "local-user-profile",
      createdAt
    }
  );
}

/**
 * Apply a partial edit to the user profile. Only the provided fields change; text fields are
 * trimmed; an invalid `preferredStrength` is ignored rather than corrupting the value. Pure &
 * immutable — returns a new state with an audit event.
 */
export function updateProfile(state: ProductState, patch: Partial<EditableProfileFields>): ProductState {
  const profile: UserProfile = { ...state.profile };
  for (const field of TEXT_FIELDS) {
    const value = patch[field];
    if (typeof value === "string") {
      profile[field] = value.trim();
    }
  }
  if (patch.preferredStrength && VALID_STRENGTHS.includes(patch.preferredStrength)) {
    profile.preferredStrength = patch.preferredStrength;
  }
  return auditProfile(state, profile, "个人档案已更新", "用户编辑了显性档案字段");
}

/** Add a hard boundary the interviewer must respect. Trimmed; blanks and exact duplicates are
 *  ignored; newest first. */
export function addExplicitBoundary(state: ProductState, text: string): ProductState {
  const boundary = text.trim();
  if (!boundary || state.profile.explicitBoundaries.includes(boundary)) {
    return state;
  }
  const profile: UserProfile = {
    ...state.profile,
    explicitBoundaries: [boundary, ...state.profile.explicitBoundaries]
  };
  return auditProfile(state, profile, "新增用户边界", boundary);
}

/** Remove a boundary by exact text. No-op (returns the same state) when it isn't present. */
export function removeExplicitBoundary(state: ProductState, text: string): ProductState {
  if (!state.profile.explicitBoundaries.includes(text)) {
    return state;
  }
  const profile: UserProfile = {
    ...state.profile,
    explicitBoundaries: state.profile.explicitBoundaries.filter((item) => item !== text)
  };
  return auditProfile(state, profile, "移除用户边界", text);
}

// ── P0b: profile self-learning (HITL) ──────────────────────────────────────────────────────
// finalize proposes that currentFocus / longTermGoal has shifted; the proposal is queued for the
// user to approve/reject. The profile is NEVER silently overwritten by inference.

export interface ProfileSuggestionInput {
  field: ProfileSuggestionField;
  suggestedValue: string;
  reason: string;
  evidenceQuote: string;
}

/** Queue finalize-time profile suggestions as pending, snapshotting the field's current value so
 *  the reviewer sees a real before→after. Blank suggestions and no-ops (suggested === current) are
 *  dropped so the user is never asked to confirm a change that isn't one. */
export function addProfileSuggestions(
  state: ProductState,
  inputs: ProfileSuggestionInput[],
  sourceSessionId: string,
  createdAt: string
): ProductState {
  const fresh: ProfileSuggestion[] = [];
  for (const input of inputs) {
    const suggestedValue = input.suggestedValue.trim();
    const currentValue = state.profile[input.field] ?? "";
    if (!suggestedValue || suggestedValue === currentValue.trim()) {
      continue;
    }
    fresh.push({
      id: makeId("profile-suggestion"),
      field: input.field,
      currentValue,
      suggestedValue,
      reason: input.reason.trim(),
      evidenceQuote: input.evidenceQuote.trim(),
      sourceSessionId,
      status: "pending",
      createdAt
    });
  }
  if (fresh.length === 0) {
    return state;
  }
  const next = cloneState(state);
  next.profileSuggestions = [...fresh, ...next.profileSuggestions];
  return withAuditEvent(next, {
    type: "profile_suggestion_created",
    label: "档案更新建议待审",
    detail: fresh.map((s) => `${s.field}: ${s.suggestedValue}`).join("；"),
    severity: "info",
    entityType: "user_profile",
    entityId: "local-user-profile",
    createdAt
  });
}

/** Approve a pending suggestion: apply suggestedValue to the profile field and mark it approved. */
export function approveProfileSuggestion(state: ProductState, suggestionId: string): ProductState {
  const suggestion = state.profileSuggestions.find((s) => s.id === suggestionId);
  if (!suggestion || suggestion.status !== "pending") {
    return state;
  }
  const reviewedAt = nowIso();
  const next = cloneState(state);
  next.profile = { ...next.profile, [suggestion.field]: suggestion.suggestedValue };
  next.profileSuggestions = next.profileSuggestions.map((s) =>
    s.id === suggestionId ? { ...s, status: "approved", reviewedAt } : s
  );
  return withAuditEvent(next, {
    type: "profile_suggestion_approved",
    label: "档案更新建议已采纳",
    detail: `${suggestion.field}：「${suggestion.currentValue}」→「${suggestion.suggestedValue}」`,
    severity: "info",
    entityType: "user_profile",
    entityId: "local-user-profile",
    createdAt: reviewedAt
  });
}

/** Reject a pending suggestion: mark rejected WITHOUT touching the profile. */
export function rejectProfileSuggestion(state: ProductState, suggestionId: string): ProductState {
  const suggestion = state.profileSuggestions.find((s) => s.id === suggestionId);
  if (!suggestion || suggestion.status !== "pending") {
    return state;
  }
  const reviewedAt = nowIso();
  const next = cloneState(state);
  next.profileSuggestions = next.profileSuggestions.map((s) =>
    s.id === suggestionId ? { ...s, status: "rejected", reviewedAt } : s
  );
  return withAuditEvent(next, {
    type: "profile_suggestion_rejected",
    label: "档案更新建议已拒绝",
    detail: `${suggestion.field}：${suggestion.suggestedValue}`,
    severity: "info",
    entityType: "user_profile",
    entityId: "local-user-profile",
    createdAt: reviewedAt
  });
}
