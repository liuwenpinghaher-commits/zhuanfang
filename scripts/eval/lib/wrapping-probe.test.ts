import { describe, expect, it } from "vitest";
import { looksLikeOwnerBook } from "./looks-like-owner-book.mjs";
import { nextProbeAction, WRITE_ACTIONS, assertWriteAfterReadonly } from "./wrapping-probe.mjs";

const mia = {
  profile: { name: "Mia" },
  sessions: [],
  notes: [{ id: "note-seed-1", sessionId: "session-seed-1" }],
  memoryRecords: [],
  revision: 0
};

const owner = {
  profile: { name: "主人" },
  sessions: [{ id: "sess-live-1" }],
  notes: [{ id: "note-2026-owner", sessionId: "sess-live-1" }],
  memoryRecords: [{ id: "mem-1" }],
  revision: 12
};

describe("looksLikeOwnerBook (shipped)", () => {
  it("is false for Mia note-seed-* / session-seed-* fingerprint", () => {
    expect(looksLikeOwnerBook(mia)).toBe(false);
    expect(looksLikeOwnerBook({ profile: { name: "Mia" }, sessions: [], notes: [], memoryRecords: [] })).toBe(false);
  });

  it("is true for a non-seed session id", () => {
    expect(looksLikeOwnerBook(owner)).toBe(true);
    expect(
      looksLikeOwnerBook({
        profile: { name: "Mia" },
        sessions: [{ id: "sess-not-seed" }],
        notes: [{ id: "note-seed-1" }],
        memoryRecords: []
      })
    ).toBe(true);
  });

  it("eval-marker profile is not owner", () => {
    expect(
      looksLikeOwnerBook({
        profile: { name: "eval-marker-abc" },
        sessions: [],
        notes: [],
        memoryRecords: []
      })
    ).toBe(false);
  });
});

describe("wrapping-probe order helper (shipped)", () => {
  it("token present aborts with zero writes", () => {
    const d = nextProbeAction("start", { tokenPresent: true });
    expect(d.action).toBe("abort");
    expect(d.code).toBe(2);
    expect(d.writes).toBe(false);
    expect(d.reason).toBe("PRODUCT_API_TOKEN_present");
  });

  it("GET-before-PUT: start never returns a write", () => {
    const local = nextProbeAction("start", { tokenPresent: false, isPublicDemo: false });
    expect(local.action).toBe("get_sim");
    expect(local.writes).toBe(false);
    expect(WRITE_ACTIONS.has(local.action)).toBe(false);

    const publicNeedSsh = nextProbeAction("start", { tokenPresent: false, isPublicDemo: true, sshFlagsOk: false });
    expect(publicNeedSsh.action).toBe("abort");
    expect(publicNeedSsh.writes).toBe(false);
  });

  it("owner book after sim GET aborts with zero writes", () => {
    const d = nextProbeAction("sim_gotten", { simLooksLikeOwner: true });
    expect(d.action).toBe("abort");
    expect(d.reason).toBe("looksLikeOwnerBook");
    expect(d.writes).toBe(false);
  });

  it("put_marker is the first write and only after both GETs", () => {
    const afterWitness = nextProbeAction("witness_gotten", { witnessSharesOwnerBook: false });
    expect(afterWitness.action).toBe("put_marker");
    expect(afterWitness.writes).toBe(true);
    expect(() => assertWriteAfterReadonly(["get_sim", "get_witness"], "put_marker")).not.toThrow();
    expect(() => assertWriteAfterReadonly(["put_marker"], "put_marker")).toThrow(/write before get_sim|put_marker before/);
  });
});
