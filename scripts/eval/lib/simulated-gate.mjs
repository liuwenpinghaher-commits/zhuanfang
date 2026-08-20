/**
 * Mechanical lock: simulated samples must never stamp GATE-HUMAN-VALUE go.
 */
export const GAP_CAPABILITY_IDS = [
  "C-emotion",
  "C-control-hold",
  "C-control-dig",
  "C-control-close",
  "C-challenge-budget"
];

export function assertSimulatedGate(sample) {
  if (!sample || sample.source !== "simulated") return;

  const verdict =
    sample.user_value_verdict ?? sample.gateHumanValue ?? sample.gates?.humanValue;
  if (verdict && verdict !== "insufficient_data") {
    throw new Error(
      `simulated samples cannot encode GATE-HUMAN-VALUE ${verdict}; only insufficient_data`
    );
  }

  if (sample.engineering_pr_claims_go === true || sample.gates?.engineeringGo === true) {
    throw new Error("simulated samples cannot set engineering_pr_claims_go true");
  }

  if (sample.gate_status === "go") {
    throw new Error("simulated samples cannot encode gate_status go");
  }
}

export function assertCoverageNotFakePass(capabilityId, result) {
  if (GAP_CAPABILITY_IDS.includes(capabilityId) && result === "pass") {
    throw new Error(`${capabilityId} coverage may only be gap, never pass`);
  }
}
