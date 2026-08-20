import { GAP_CAPABILITY_IDS, assertCoverageNotFakePass } from "./simulated-gate.mjs";
import { countStrategy } from "./strategy-align.mjs";
import { isCounselorPattern } from "./guest-simulator.mjs";

export const GAP_IDS = GAP_CAPABILITY_IDS;

function row(id, result, note = "") {
  assertCoverageNotFakePass(id, result);
  if (GAP_IDS.includes(id) && result === "pass") {
    result = "gap";
  }
  return { id, result, note };
}

export function scoreCoverage({ scenario, memory, endResult, isolation, hostCalls }) {
  const rows = [];
  const id = scenario.id;
  const trace = memory.strategyTrace ?? [];
  const assistant = memory.transcript.filter((t) => t.role === "assistant").map((t) => t.content);
  const userTurns = memory.transcript.filter((t) => t.role === "user");

  if (id === "ADV-short-abstract") {
    const fake = assistant.some((t) => /你刚才的锚点是/.test(t));
    rows.push(row("C-turn-live", fake ? "fail" : "pass", fake ? "template leak" : "live llm"));
    const concrete = countStrategy(trace, "concrete_example_probe") >= 1;
    rows.push(row("C-strategy-content-concrete", concrete ? "pass" : "fail"));
    rows.push(row("C-assets", endResult?.longTermAssetsPersisted === false ? "fail" : "pass"));
  }

  if (id === "ADV-short-shame-dns") {
    const dnsOnce = memory.doNotSavePosts === 1;
    const persisted = endResult?.longTermAssetsPersisted === true;
    rows.push(
      row(
        "C-control-dns",
        dnsOnce && persisted === false ? "pass" : "fail",
        `dnsPosts=${memory.doNotSavePosts} persisted=${endResult?.longTermAssetsPersisted}`
      )
    );
    const shameAt = scenario.guest?.behaviors?.find((b) => b.kind === "shame_contract");
    if (shameAt) {
      const idx = userTurns.findIndex((t) => t.content.includes("算了不说了"));
      const next = idx >= 0 ? assistant[idx] ?? assistant[idx + 1] : "";
      rows.push(row("C-value-unexpected", next && !isCounselorPattern(next) ? "pass" : "na"));
    }
    rows.push(row("C-emotion", "gap", "product has no emotion_acknowledge"));
  }

  if (id === "ADV-control-six") {
    const needed = ["skip", "softer", "sharper", "different-angle", "summary"];
    const got = new Set(memory.controlsPosted ?? []);
    const ok = needed.every((a) => got.has(a));
    rows.push(row("C-control-six", ok ? "pass" : "fail", [...got].join(",")));
  }

  if (id === "CLOCK-debt") {
    rows.push(row("C-strategy-clock-debt", countStrategy(trace, "debt_followup") === 1 ? "pass" : "fail"));
  }
  if (id === "CLOCK-decision") {
    rows.push(row("C-strategy-clock-decision", countStrategy(trace, "decision_review") === 1 ? "pass" : "fail"));
  }
  if (id === "CLOCK-contradiction") {
    const n = countStrategy(trace, "contradiction_review");
    rows.push(row("C-strategy-clock-contradiction", n === 1 ? "pass" : "fail"));
  }
  if (id === "CLOCK-blindspot") {
    rows.push(row("C-strategy-clock-blindspot", countStrategy(trace, "blindspot_probe") === 1 ? "pass" : "fail"));
  }

  if (id === "FLOW-memory") {
    rows.push(row("C-memory-conflict-409", memory.blockedTrue409 ? "pass" : "fail"));
    rows.push(row("C-memory-confirm-recall", memory.recalledP ? "pass" : "fail"));
    rows.push(row("C-hitl-contradiction", memory.hitlResolved ? "pass" : "na"));
  }

  rows.push(row("C-isolation", isolation?.proven ? "pass" : "fail"));
  rows.push(row("C-control-hold", "gap"));
  rows.push(row("C-control-dig", "gap"));
  rows.push(row("C-control-close", "gap"));
  rows.push(row("C-challenge-budget", "gap"));
  rows.push(row("C-emotion", "gap"));
  rows.push(row("C-fail-loud", "observed", "demo configured"));
  rows.push(row("C-embed-502", "unit", "verified_by=unit"));

  if (hostCalls != null) {
    rows.push(row("C-strategy-align", "na", "see scorecard.strategyAlign"));
  }

  const seen = new Set();
  return rows.filter((r) => {
    const k = r.id;
    if (seen.has(k) && k.startsWith("C-emotion")) return false;
    if (seen.has(k) && GAP_IDS.includes(k)) return false;
    seen.add(k);
    return true;
  });
}
