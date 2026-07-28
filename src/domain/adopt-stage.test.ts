import { describe, expect, it } from "vitest";
import { shouldStageLocalBeforeAdopt } from "./adopt-stage";

describe("shouldStageLocalBeforeAdopt", () => {
  it("stages when local differs from remote and lastSaved is empty (first paint)", () => {
    expect(
      shouldStageLocalBeforeAdopt({
        localSignature: "local-edit",
        remoteSignature: "server",
        lastSavedSignature: ""
      })
    ).toBe(true);
  });

  it("stages when local differs from lastSaved and from remote", () => {
    expect(
      shouldStageLocalBeforeAdopt({
        localSignature: "local-edit",
        remoteSignature: "server",
        lastSavedSignature: "older-local"
      })
    ).toBe(true);
  });

  it("does not stage when local already matches remote", () => {
    expect(
      shouldStageLocalBeforeAdopt({
        localSignature: "same",
        remoteSignature: "same",
        lastSavedSignature: ""
      })
    ).toBe(false);
  });

  it("does not stage when local equals lastSaved (already persisted content)", () => {
    expect(
      shouldStageLocalBeforeAdopt({
        localSignature: "saved",
        remoteSignature: "server-new",
        lastSavedSignature: "saved"
      })
    ).toBe(false);
  });
});
