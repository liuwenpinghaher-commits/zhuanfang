import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { assertSimulatedGate } from "./simulated-gate.mjs";

export const SIMULATED_DIR = new URL("../../../docs/superpowers/eval/samples/simulated/", import.meta.url);

export function redact(text) {
  return String(text ?? "")
    .replace(/zf_session=[^;\s]+/gi, "zf_session=REDACTED")
    .replace(/PRODUCT_API_TOKEN\s*=\s*\S+/g, "PRODUCT_API_TOKEN=REDACTED")
    .replace(/Bearer\s+\S+/gi, "Bearer REDACTED")
    .replace(/"password"\s*:\s*"[^"]*"/gi, '"password":"REDACTED"');
}

export function writeScenarioArtifacts({ rootDir, scenarioId, transcript, scorecard }) {
  assertSimulatedGate(scorecard);
  mkdirSync(rootDir, { recursive: true });
  const md = [
    `# ${scenarioId}`,
    "",
    "source: simulated",
    "user_value_verdict: insufficient_data",
    "",
    ...transcript.map((t) => `**${t.role}**: ${redact(t.content)}`)
  ].join("\n");
  const safeCard = { ...scorecard, source: "simulated", user_value_verdict: "insufficient_data", engineering_pr_claims_go: false };
  assertSimulatedGate(safeCard);
  writeFileSync(join(rootDir, `${scenarioId}.transcript.md`), redact(md), "utf8");
  writeFileSync(join(rootDir, `${scenarioId}.scorecard.json`), redact(JSON.stringify(safeCard, null, 2)), "utf8");
}

export function writeCoverageSummary(rootDir, rows) {
  mkdirSync(rootDir, { recursive: true });
  const lines = ["# coverage", "", "| id | result | note |", "|----|--------|------|"];
  for (const r of rows) {
    lines.push(`| ${r.id} | ${r.result} | ${String(r.note ?? "").replace(/\|/g, "/")} |`);
  }
  writeFileSync(join(rootDir, "coverage.md"), lines.join("\n") + "\n", "utf8");
}

export function scanSimulatedForForbiddenGo(dir = SIMULATED_DIR.pathname) {
  const hits = [];
  function walk(p) {
    let st;
    try {
      st = statSync(p);
    } catch {
      return;
    }
    if (st.isDirectory()) {
      for (const name of readdirSync(p)) walk(join(p, name));
      return;
    }
    if (!/\.(json|md)$/.test(p)) return;
    const text = readFileSync(p, "utf8");
    if (/user_value_verdict"\s*:\s*"go"/.test(text) || /gate_status:\s*go/.test(text) || /"gate_status":\s*"go"/.test(text)) {
      hits.push(p);
    }
  }
  walk(dir);
  if (hits.length) {
    throw new Error(`simulated samples contain go: ${hits.join(", ")}`);
  }
  return true;
}
