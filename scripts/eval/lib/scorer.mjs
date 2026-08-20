import { alignScore } from "./strategy-align.mjs";
import { scoreCoverage } from "./coverage.mjs";
import { isCounselorPattern } from "./guest-simulator.mjs";

export function hardMetrics(transcript) {
  const assistant = transcript.filter((t) => t.role === "assistant").map((t) => t.content ?? "");
  const user = transcript.filter((t) => t.role === "user").map((t) => t.content ?? "");
  const chars = [...assistant, ...user].join("").length;
  const qLens = assistant.map((q) => q.length);
  const avgQ = qLens.length ? Math.round(qLens.reduce((a, b) => a + b, 0) / qLens.length) : 0;
  const seen = new Set();
  let repeats = 0;
  for (const q of assistant) {
    const k = q.slice(0, 12);
    if (seen.has(k)) repeats += 1;
    seen.add(k);
  }
  const asideLeak = assistant.filter((q) => /（[^）]*）|\([^)]*\)/.test(q)).length;
  return { chars, turns: transcript.length, userTurns: user.length, avgQ, repeats, asideLeak };
}

export function craftHeuristic(transcript) {
  const assistant = transcript.filter((t) => t.role === "assistant").map((t) => t.content ?? "");
  let counselor = 0;
  let multiQ = 0;
  for (const t of assistant) {
    if (isCounselorPattern(t)) counselor += 1;
    const qs = (t.match(/[？?]/g) || []).length;
    if (qs > 1) multiQ += 1;
  }
  return {
    counselorHits: counselor,
    multiQuestionHits: multiQ,
    singleQuestionRate: assistant.length ? 1 - multiQ / assistant.length : 1
  };
}

export function buildScorecard({ scenario, memory, endResult, isolation, hostCalls, assets }) {
  const hard = hardMetrics(memory.transcript);
  const craft = craftHeuristic(memory.transcript);
  const assistant = memory.transcript.filter((t) => t.role === "assistant").map((t) => t.content);
  const strategyAlign = alignScore(memory.strategyTrace, assistant, {
    concept: "成核点",
    title: "是否放权"
  });
  const coverage = scoreCoverage({ scenario, memory, endResult, isolation, hostCalls });
  return {
    source: "simulated",
    scenarioId: scenario.id,
    user_value_verdict: "insufficient_data",
    gateHumanValue: "insufficient_data",
    engineering_pr_claims_go: false,
    gate_status: "insufficient_data",
    hard,
    craft,
    strategyAlign,
    valueProxy: {
      insight: { score: null, note: "judge optional; hard-recall only" },
      tension: { score: null, note: "na unless potentialTension" },
      unexpected: coverage.find((c) => c.id === "C-value-unexpected") ?? { result: "na" }
    },
    coverage,
    assets: assets ?? {},
    gates: {
      craftGolden: "separate-vitest",
      humanValue: "insufficient_data",
      engineeringGo: false
    },
    hostCalls
  };
}
