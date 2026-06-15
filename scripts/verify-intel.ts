// E2E for Phase 11: IntelTask create + run (real search + LLM triage).
// Run: npx tsx scripts/verify-intel.ts
import { readFileSync } from "node:fs";
import { buildApiServer } from "../apps/api/src/server";

for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m && !line.trim().startsWith("#")) process.env[m[1]] ??= m[2];
}

const server = buildApiServer();
const post = async (url: string, payload?: unknown) =>
  (await server.inject({ method: "POST", url, payload: (payload ?? {}) as object })).json() as any;

const created = await post("/api/intel/tasks", {
  name: "AI 编程 agent 监控",
  keywords: ["AI 编程 agent", "coding agent 落地"],
  provider: "anysearch"
});
const taskId = created.task.id;
console.log("=== Phase 11：IntelTask 自动化情报 ===");
console.log("已创建任务:", created.task.name, "| keywords:", created.task.keywords);

const run = await post(`/api/intel/tasks/${taskId}/run`);
console.log("\n本次抓取入库:", run.count, "条");
const items = (run.state.intelItems ?? []).filter((i: any) => i.taskId === taskId);
for (const it of items.slice(0, 5)) {
  console.log(`\n· [${it.category} | 相关度${it.relevance}] ${it.title}`);
  console.log(`  ${it.summary}`);
  console.log(`  来源: ${it.url}`);
  if (it.claims?.length) console.log(`  主张: ${it.claims.join(" / ")}`);
}

// promote first item to a knowledge debt (today's-desk integration)
if (items[0]) {
  const toDebt = await post(`/api/intel/items/${items[0].id}/to-debt`);
  const debt = (toDebt.state.debts ?? [])[0];
  console.log("\n转知识债:", debt?.concept, "—", debt?.nextQuestion);
}

const realUrls = items.some((i: any) => /^https?:\/\//.test(i.url) && !i.url.includes("/search/"));
console.log("\n判定 → 入库>0:", run.count > 0, "| 真实来源:", realUrls, "| 有摘要/分类:", items[0]?.summary?.length > 0);
console.log(run.count > 0 && realUrls ? "✅ Phase 11：真情报抓取 + LLM 分诊" : "⚠️ 复核（取决于 provider）");

await server.close();
