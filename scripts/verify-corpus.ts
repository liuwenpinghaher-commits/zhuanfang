// E2E for Phase 6: real LLM corpus analysis. Run: npx tsx scripts/verify-corpus.ts
import { readFileSync } from "node:fs";
import { buildApiServer } from "../apps/api/src/server";

for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m && !line.trim().startsWith("#")) process.env[m[1]] ??= m[2];
}

const server = buildApiServer();
const post = async (url: string, payload?: unknown) =>
  (await server.inject({ method: "POST", url, payload: (payload ?? {}) as object })).json() as any;

const sample = [
  "主持人：你说这道菜失败了，具体是哪一步让你觉得不对？",
  "被访者：可能是火候吧，我总是等油开始冒烟才下锅。",
  "主持人：等油冒烟——这是你一直以来的习惯，还是这次特意这么做的？",
  "被访者：一直这样，我妈就是这么教我的。",
  "主持人：如果不靠看烟，你还能用什么信号来判断油温到了？",
  "被访者：……好像我从来没想过别的办法。",
  "主持人：那这次我们换个方式，下次你试试用筷子插进油里看气泡，再回来告诉我区别。"
].join("\n");

const r = await post("/api/corpus/insights", { title: "做菜复盘访谈样本", mediaType: "text", content: sample });
const insight = r.insight;

console.log("=== Phase 6：语料分析（应针对'做菜/油温'样本，而非模板）===");
console.log("标题:", insight.title);
for (const d of insight.dimensions) {
  console.log(`\n维度: ${d.name}（${d.score}/5）`);
  console.log("  发现:", d.finding);
  console.log("  原话:", d.example);
}
console.log("\nPlaybookPatch:", insight.recommendedPatches[0]?.title);
console.log("  规则:", insight.recommendedPatches[0]?.rules);

const blob = JSON.stringify(insight);
const DET_PATCH = "先索要具体时刻，再做机制反转";
const isTemplate = insight.recommendedPatches[0]?.title === DET_PATCH && /机制奖励了报喜不报忧/.test(blob);
const onSample = /油温|火候|冒烟|筷子|气泡|做菜|信号/.test(blob);
console.log("\n判定 → 是确定性模板:", isTemplate, "｜ 针对真实样本:", onSample);
console.log(onSample && !isTemplate ? "✅ Phase 6：真 LLM 语料分析" : "⚠️ 复核（可能回退到模板）");

await server.close();
