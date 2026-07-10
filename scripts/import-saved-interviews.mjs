// Recover the 10 validated interviews into the LIVE system. The validation driver purged state
// before each interview (for isolated quality measurement), so only the last one survived in the
// archive. Each interview's full finalized ProductState was saved to /tmp/interviews/<persona>.json;
// here we MERGE all 10 (sessions + notes + cognitive assets + memory) into one state and import it,
// so 专访档案 shows all 10 sessions and 认知资产库 shows every interview's assets.
import { readFileSync } from "node:fs";

function loadEnv(url) { const e = {}; try { for (const l of readFileSync(url, "utf8").split(/\r?\n/)) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !l.trim().startsWith("#")) e[m[1]] = m[2]; } } catch {} return e; }
const env = loadEnv(new URL("../.env.local", import.meta.url));
const API = env.PRODUCT_API_BASE || "http://127.0.0.1:3210";

const PERSONAS = ["01-ai-researcher","02-agent-founder","03-vc-investor","04-math-ai","05-rl-posttraining","06-chip-infra","07-robotics","08-opensource-llm","09-product-philosopher","10-science-ai"];
// Per-entity arrays that hold interview content and should accumulate across all 10.
const MERGE_KEYS = ["sessions","notes","points","questions","decisions","debts","themes","memoryCandidates","memoryRecords","memoryEdges","aiRunEvents"];

const states = PERSONAS.map((n) => JSON.parse(readFileSync(`/tmp/interviews/${n}.json`, "utf8")).ended.state);

// Base = first interview's state (carries profile/systemConfig/etc); then append the rest.
const merged = structuredClone(states[0]);
for (const key of MERGE_KEYS) merged[key] = Array.isArray(merged[key]) ? merged[key].slice() : [];
for (let i = 1; i < states.length; i++) {
  for (const key of MERGE_KEYS) {
    const arr = states[i][key];
    if (Array.isArray(arr)) merged[key].push(...arr);
  }
}
// Clean the audit log of the per-interview purge markers; the import endpoint stamps its own event.
merged.auditEvents = [];

console.log("=== 合并后将导入 ===");
for (const key of MERGE_KEYS) console.log(`  ${key}: ${merged[key].length}`);

const res = await fetch(`${API}/api/state/import`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  // F-04(B2#3):裸 state(无 rawMaterials/audios 数组)属 legacy 包,新契约要求显式声明冷层去向,
  // 否则 422。本脚本是"恢复保存的访谈"——现有冷层(逐字稿/录音)可能正属于这些 session,
  // 必须保留,故选 preserve-cold(只替换热态,冷层原样不动)。
  body: JSON.stringify({ confirm: "REPLACE_ALL_STATE", coldLayerMode: "preserve-cold", state: merged }),
  signal: AbortSignal.timeout(60000)
});
if (!res.ok) { console.error("IMPORT FAILED:", res.status, (await res.text()).slice(0, 300)); process.exit(1); }
const after = await (await fetch(`${API}/api/state`)).json();
console.log("\n=== 导入后 LIVE state ===");
console.log("专访档案 sessions:", after.sessions.length);
for (const s of after.sessions) console.log("   -", (s.title || "").slice(0, 44), `[${s.status}]`);
console.log("认知资产: points", after.points.length, "| questions", after.questions.length, "| decisions", after.decisions.length, "| debts", after.debts.length, "| themes", after.themes.length);
console.log("双轨笔记 notes:", after.notes.length, "| 记忆候选:", after.memoryCandidates.length);
