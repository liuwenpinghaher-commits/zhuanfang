/**
 * TypeScript facade for the shipped simulated-gate lock.
 * Implementation lives in simulated-gate.mjs — tests must import these exports,
 * not a copy of the predicate.
 */
export {
  assertSimulatedGate,
  GAP_CAPABILITY_IDS,
  assertCoverageNotFakePass
} from "./simulated-gate.mjs";

export type SimulatedGateSample = {
  source?: string;
  user_value_verdict?: string;
  gateHumanValue?: string;
  engineering_pr_claims_go?: boolean;
  gate_status?: string;
  gates?: { humanValue?: string; engineeringGo?: boolean };
};
