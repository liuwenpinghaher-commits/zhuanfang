/**
 * Functional-loop smoke (Phase E).
 * 1) Structural: shipped modules export required symbols.
 * 2) Domain: run vitest domain suite for revisit + loop golden (real shipped functions).
 *
 * Usage (repo root):
 *   REAL_PROVIDER_SMOKE=off node scripts/loop-workflow-smoke.mjs
 *
 * Does not start Surreal / browser — safe on low-memory hosts.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outPath =
  process.env.LOOP_SMOKE_OUT ||
  path.join(root, "docs/superpowers/2026-08-05-loop-workflow-smoke.json");

const requiredFiles = [
  "src/domain/revisit-queue.ts",
  "src/domain/loop-golden.ts",
  "src/domain/revisit-queue.test.ts",
  "src/domain/loop-golden.test.ts",
  "src/features/home/HomeView.tsx",
  "src/features/interview/InterviewView.tsx",
  "src/features/my-assets/MyAssetsView.tsx",
  "src/domain/session-archive.ts"
];

const requiredSnippets = [
  { file: "src/domain/revisit-queue.ts", needle: "export function buildCognitiveRevisitQueue" },
  { file: "src/domain/revisit-queue.ts", needle: "export function pickInterviewLaunchRecommendation" },
  { file: "src/domain/context-pack.ts", needle: "pickInterviewLaunchRecommendation" },
  { file: "src/domain/strategy.ts", needle: "suppressedRevisitIds" },
  { file: "src/features/home/HomeView.tsx", needle: "revisit-desk" },
  { file: "src/features/interview/InterviewView.tsx", needle: "interview-revisit-panel" },
  { file: "src/App.tsx", needle: "sticky-memory-hitl" },
  { file: "src/App.tsx", needle: "pickInterviewLaunchRecommendation" },
  { file: "src/features/my-assets/MyAssetsView.tsx", needle: "buildSessionArchive" },
  { file: "src/features/my-assets/MyAssetsView.tsx", needle: "专访档案" }
];

const result = {
  startedAt: new Date().toISOString(),
  ok: true,
  structural: [],
  vitest: null,
  errors: []
};

function fail(msg) {
  result.ok = false;
  result.errors.push(msg);
  console.error("FAIL:", msg);
}

for (const rel of requiredFiles) {
  const abs = path.join(root, rel);
  const exists = fs.existsSync(abs);
  result.structural.push({ check: "file", rel, ok: exists });
  if (!exists) fail(`missing file ${rel}`);
}

for (const { file, needle } of requiredSnippets) {
  const abs = path.join(root, file);
  const text = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : "";
  const ok = text.includes(needle);
  result.structural.push({ check: "snippet", file, needle, ok });
  if (!ok) fail(`missing snippet in ${file}: ${needle}`);
}

const vitest = spawnSync(
  "npx",
  [
    "vitest",
    "run",
    "--config",
    "vitest.domain.config.ts",
    "src/domain/revisit-queue.test.ts",
    "src/domain/loop-golden.test.ts",
    "src/domain/craft-golden.test.ts",
    "src/domain/session-archive.test.ts",
    "src/domain/session-authority.test.ts",
    "src/domain/memory-discipline.test.ts"
  ],
  {
    cwd: root,
    env: { ...process.env, REAL_PROVIDER_SMOKE: "off" },
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024
  }
);

result.vitest = {
  status: vitest.status,
  stdoutTail: (vitest.stdout || "").slice(-2000),
  stderrTail: (vitest.stderr || "").slice(-1000)
};

if (vitest.status !== 0) {
  fail(`vitest exit ${vitest.status}`);
  console.log(vitest.stdout);
  console.error(vitest.stderr);
}

result.finishedAt = new Date().toISOString();
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify({ ok: result.ok, outPath, errors: result.errors }, null, 2));
process.exit(result.ok ? 0 : 1);
