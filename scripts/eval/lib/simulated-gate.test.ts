import { describe, expect, it } from "vitest";
import {
  assertSimulatedGate,
  assertCoverageNotFakePass
} from "./simulated-gate.ts";
import { scanSimulatedForForbiddenGo } from "./artifacts.mjs";

describe("assertSimulatedGate (shipped)", () => {
  it('source:"simulated" + user_value_verdict:"go" throws', () => {
    expect(() =>
      assertSimulatedGate({ source: "simulated", user_value_verdict: "go" })
    ).toThrow(/cannot encode GATE-HUMAN-VALUE go/);
    expect(() =>
      assertSimulatedGate({ source: "simulated", gate_status: "go" })
    ).toThrow(/gate_status go/);
    expect(() =>
      assertSimulatedGate({ source: "simulated", engineering_pr_claims_go: true })
    ).toThrow(/engineering_pr_claims_go/);
  });

  it("insufficient_data is allowed", () => {
    expect(() =>
      assertSimulatedGate({
        source: "simulated",
        user_value_verdict: "insufficient_data",
        engineering_pr_claims_go: false,
        gate_status: "insufficient_data"
      })
    ).not.toThrow();
  });

  it("human samples are not locked", () => {
    expect(() => assertSimulatedGate({ source: "human", user_value_verdict: "go" })).not.toThrow();
  });

  it("C-emotion coverage cannot pass", () => {
    expect(() => assertCoverageNotFakePass("C-emotion", "pass")).toThrow(/only be gap/);
    expect(() => assertCoverageNotFakePass("C-emotion", "gap")).not.toThrow();
    expect(() => assertCoverageNotFakePass("C-control-hold", "pass")).toThrow(/only be gap/);
  });

  it("scans samples/simulated for forbidden go", () => {
    expect(scanSimulatedForForbiddenGo()).toBe(true);
  });
});
