// E2E for Phase 3 (questioning uses guide context) + Phase 4 (LLM reviews).
// Run: npx tsx scripts/verify-deepen-review.ts
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

const created = await post("/api/interview-sessions", { mode: "decision", strength: "standard" });
const sessionId = created.session.id;
const guide = created.session.guide ?? {};
console.log("=== Phase 3：会前 guide 注入的上下文 ===");
console.log("盲区候选 :", (guide.blindspotCandidates ?? []).map((b: any) => b.concept).join("、") || "（无）");
console.log("未还知识债:", (guide.openDebts ?? []).map((d: any) => d.concept).join("、") || "（无）");
console.log("可引用历史:", (guide.relevantMemories ?? []).slice(0, 3).join(" / ") || "（无）");

const turns = [
  "我们团队最近老是等我拍板，什么事都要我最后确认。",
  "我也想放手，但每次一放手就出问题，我又得回去收拾。",
  "可能我心里还是怕，怕他们的决定我最后没法兜底。"
];
console.log("\n=== Phase 3：会中追问（看是否引用历史/戳盲区/回访知识债）===");
for (const t of turns) {
  const r = await post(`/api/interview-sessions/${sessionId}/turns`, { content: t });
  console.log("\n用户:", t);
  console.log("主持人:", r.session.turns.at(-1)?.content);
}

const ended = await post(`/api/interview-sessions/${sessionId}/end`);
console.log("\n=== Phase 2：本次日记 summary ===");
console.log(ended.note.summary);

console.log("\n=== Phase 4：LLM 回顾（GET /api/reviews）===");
const reviews = await get("/api/reviews");
console.log("[月度] topTheme        :", reviews.monthly.topTheme);
console.log("[月度] changedView     :", reviews.monthly.changedView);
console.log("[月度] avoidedQuestion :", reviews.monthly.avoidedQuestion);
console.log("[月度] 推荐下次专访     :", reviews.monthly.recommendedNextInterview);
console.log("[月度] metrics(计数)   :", JSON.stringify(reviews.monthly.metrics));
console.log("[年度] coreQuestions   :", reviews.yearly.coreQuestions);
console.log("[年度] changedViews    :", reviews.yearly.changedViews);
console.log("[年度] nextYearFocus   :", reviews.yearly.nextYearFocus);
console.log("[雷达] assets(计数保留):", reviews.radar.assets.map((m: any) => `${m.label}:${m.value}`).join(" "));

const HARDCODED = "继续追踪控制感、授权机制和问题定义权之间的关系。";
console.log("\n判定 → nextYearFocus 仍是写死字符串:", reviews.yearly.nextYearFocus === HARDCODED);
console.log(reviews.yearly.nextYearFocus !== HARDCODED ? "✅ Phase 4：回顾是真 LLM 综合（非模板）" : "⚠️ 回顾疑似回退到了确定性模板（检查 LLM 是否被调用）");

await server.close();
