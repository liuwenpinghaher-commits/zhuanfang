// E2E for Phase 9: document import -> candidate memories. Run: npx tsx scripts/verify-import.ts
import { readFileSync } from "node:fs";
import { buildApiServer } from "../apps/api/src/server";

for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m && !line.trim().startsWith("#")) process.env[m[1]] ??= m[2];
}

const server = buildApiServer();
const post = async (url: string, payload?: unknown) =>
  (await server.inject({ method: "POST", url, payload: (payload ?? {}) as object })).json() as any;

const doc = [
  "# 我的产品笔记",
  "",
  "我决定在 2026 下半年把团队从 8 人砍到 5 人，集中做一个核心功能，而不是同时铺三条线。",
  "",
  "我一直认为，过早追求规模是大多数早期团队失败的根因——我自己上一家公司就栽在这上面。",
  "",
  "还有个一直没搞懂的问题：到底该用什么指标判断一个功能值不值得继续投入？留存？时长？还是付费转化？",
  "",
  "（私事：我最近睡眠很差，常常凌晨三点惊醒，担心现金流。）"
].join("\n");

const r = await post("/api/import/documents", { title: "我的产品笔记", content: doc, sourceType: "text" });
console.log("=== Phase 9：导入资料 → 候选记忆 ===");
console.log("sourceId      :", r.sourceId);
console.log("候选记忆数    :", r.candidateCount);
const cands = (r.state.memoryCandidates ?? []).filter((c: any) => c.sourceId === r.sourceId);
for (const c of cands) {
  console.log(`\n· [${c.sensitivity}] ${c.text}`);
  console.log(`  证据: ${c.evidenceQuote}`);
  console.log(`  评分: ${c.reviewScore} | 状态: ${c.status}`);
}
const src = (r.state.importSources ?? []).find((s: any) => s.id === r.sourceId);
console.log("\n切分片段数    :", src?.chunkIds?.length);

const onTopic = JSON.stringify(cands).match(/团队|规模|指标|留存|现金流|睡眠/g);
const hasSensitive = cands.some((c: any) => c.sensitivity === "sensitive");
console.log("\n判定 → 候选数>0:", r.candidateCount > 0, "| 切中内容:", !!onTopic, "| 识别敏感:", hasSensitive);
console.log(r.candidateCount > 0 && onTopic ? "✅ Phase 9：真抽取候选记忆（待人审）" : "⚠️ 复核");

await server.close();
