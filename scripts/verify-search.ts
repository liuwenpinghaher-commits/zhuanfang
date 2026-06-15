// E2E for Phase 5: real search + LLM insight synthesis. Run: npx tsx scripts/verify-search.ts
import { readFileSync } from "node:fs";
import { buildApiServer } from "../apps/api/src/server";

for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m && !line.trim().startsWith("#")) process.env[m[1]] ??= m[2];
}

const server = buildApiServer();
const post = async (url: string, payload?: unknown) =>
  (await server.inject({ method: "POST", url, payload: (payload ?? {}) as object })).json() as any;
const get = async (url: string) => (await server.inject({ method: "GET", url })).json() as any;

const state = await get("/api/state");
console.log("活跃搜索 provider:", state.systemConfig.search.activeProvider);

console.log("\n=== 手动 AnySearch 简报（真来源 + LLM 综合 insight）===");
const manual = await post("/api/search/briefs", {
  topic: "2026 年 AI 编程 agent 的真实落地进展",
  providerId: "anysearch",
  maxSources: 4,
  recencyDays: 30
});
const b = manual.brief;
if (!b) {
  console.log("❌ 简报为空：", JSON.stringify(manual).slice(0, 200));
} else {
  console.log("summary :", b.summary);
  console.log("facts   :", b.facts);
  console.log("争议    :", b.controversies);
  console.log("反方    :", b.opposingViews);
  console.log("来源    :");
  for (const s of b.sources.slice(0, 4)) console.log(`  - ${s.title} <${s.url}>`);
  const realSources = b.sources.some((s: any) => /^https?:\/\//.test(s.url) && !s.url.includes("dashscope.aliyun.com/search/"));
  const templatedSummary = b.summary.includes("AnySearch 围绕");
  console.log("\n判定 → 来源是真实 URL:", realSources, "｜ summary 仍是模板:", templatedSummary);
  console.log(realSources && !templatedSummary ? "✅ 真搜索 + 真综合" : "⚠️ 复核（可能回退到模板或 LLM 未触发）");
}

console.log("\n=== 自动简报（auto-brief 现在真联网）===");
const themeId = state.themes[0]?.id;
const auto = await post("/api/search/auto-briefs", { themeId });
const ab = auto.brief;
console.log("topic   :", ab?.topic);
console.log("summary :", ab?.summary);
console.log("来源数  :", ab?.sources?.length, "｜ 首条:", ab?.sources?.[0]?.url);
const autoReal = (ab?.sources ?? []).some((s: any) => /^https?:\/\//.test(s.url) && !s.url.includes("/search/"));
console.log("判定 → auto-brief 命中真实来源:", autoReal, autoReal ? "✅" : "（取决于活跃 provider 是否为 bailian/anysearch）");

await server.close();
