import { describe, expect, it } from "vitest";
import {
  applyOverlay,
  assertFullPutBody,
  isFragmentPutBody,
  rejectOverlayOnlyPut,
  clockBlindspotOverlay
} from "./fixtures.mjs";

const stored = {
  revision: 7,
  profile: { name: "eval-marker-x" },
  sessions: [],
  notes: [],
  debts: [],
  decisions: [],
  points: [],
  playbookPatches: [],
  systemConfig: { interview: { maxFollowUpDepth: 4, challengeBudgetPerSession: 3 } },
  memoryRecords: []
};

describe("applyOverlay (shipped)", () => {
  it("rejects overlay-only {revision, debts} (Mia seed fallback)", () => {
    const fragment = { revision: 7, debts: [{ id: "debt-eval-1" }] };
    expect(isFragmentPutBody(fragment)).toBe(true);
    expect(() => rejectOverlayOnlyPut(fragment)).toThrow(/overlay-only PUT rejected/);
    expect(() => assertFullPutBody(fragment, stored)).toThrow(/seed fallback would reintroduce Mia/);
  });

  it("GET stored + overlay keeps revision and deep-merges systemConfig", () => {
    const body = applyOverlay(stored, {
      ...clockBlindspotOverlay(),
      debts: [{ id: "debt-eval-1", status: "待了解", concept: "成核点" }]
    });
    expect(body.revision).toBe(7);
    expect(body.systemConfig.interview.maxFollowUpDepth).toBe(8);
    expect(body.systemConfig.interview.challengeBudgetPerSession).toBe(3);
    expect(body.sessions).toEqual([]);
    expect(body.notes).toEqual([]);
    expect(isFragmentPutBody(body)).toBe(false);
  });
});
