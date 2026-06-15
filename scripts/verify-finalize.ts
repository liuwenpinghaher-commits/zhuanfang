// E2E check for Phase 2: real interview -> LLM diary that reflects the ACTUAL
// conversation (not the hardcoded 救火/授权 script). Run: npx tsx scripts/verify-finalize.ts
import { readFileSync } from "node:fs";
import { buildApiServer } from "../apps/api/src/server";

for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m && !line.trim().startsWith("#")) process.env[m[1]] ??= m[2];
}

const server = buildApiServer(); // in-memory state, provider clients from env

async function post(url: string, payload: unknown) {
  const res = await server.inject({ method: "POST", url, payload: payload as object });
  return res.json() as any;
}

const created = await post("/api/interview-sessions", { mode: "decision", strength: "standard" });
const sessionId = created.session.id;
console.log("session:", sessionId, "| 种子标题:", created.session.title);

const turns = [
  "我最近一直在纠结，要不要从大厂离职去做独立开发者。",
  "其实我不缺钱，真正怕的是失去那种稳定的身份感和团队归属。",
  "如果真离开，最坏可能是一整年都做不出东西，然后灰溜溜回去找工作。"
];
let before: any = { points: [], questions: [], decisions: [], debts: [], themes: [] };
for (const t of turns) {
  const r = await post(`/api/interview-sessions/${sessionId}/turns`, { content: t });
  before = r.state;
  console.log("\n用户:", t);
  console.log("主持人:", r.session.turns.at(-1)?.content?.slice(0, 140));
}

const ended = await post(`/api/interview-sessions/${sessionId}/end`, {});
const note = ended.note;
const state = ended.state;

// Newly-created assets are PREPENDED by mergeFinalizedState; slice off the delta
// so we judge what THIS finalize produced, not pre-seeded demo assets.
const added = (key: string) => state[key].slice(0, state[key].length - before[key].length);
const newPoints = added("points"), newQuestions = added("questions"), newDecisions = added("decisions"), newDebts = added("debts");
const newThemes = state.themes.filter((t: any) => !before.themes.some((b: any) => b.id === t.id));

console.log("\n=== 双轨笔记（本次 finalize 产出）===");
console.log("summary  :", note.summary);
console.log("keyQuote :", note.keyQuote);
console.log("saidTrack:", note.saidTrack);
console.log("learned  :", note.learnedTrack);
console.log("next     :", note.nextQuestions);

console.log("\n=== 新增沉淀资产（仅本次新建）===");
console.log(`观点(${newPoints.length}):`, newPoints.map((p: any) => p.title).join(" / ") || "（无）");
console.log(`问题(${newQuestions.length}):`, newQuestions.map((q: any) => q.question).join(" / ") || "（无）");
console.log(`决策(${newDecisions.length}):`, newDecisions.map((d: any) => `${d.title}[reviewAt:${d.reviewAt}]`).join(" / ") || "（无，未达成明确决策）");
console.log(`知识债(${newDebts.length}):`, newDebts.map((d: any) => d.concept).join(" / ") || "（无）");
console.log(`新主题(${newThemes.length}):`, newThemes.map((t: any) => t.name).join(" / ") || "（无，归并到已有主题）");

const blob = JSON.stringify({ note, newPoints, newQuestions, newDecisions, newDebts, newThemes });
const rescueScript = /救火|兜底|授权机制|亲自/.test(blob);
const onTopic = /离职|独立开发|大厂|身份|归属|稳定/.test(blob);
console.log("\n判定 → 含旧剧本词(救火/兜底/授权):", rescueScript, "｜ 含真实话题词(离职/独立/身份):", onTopic);
console.log(onTopic && !rescueScript ? "✅ PASS：日记真实反映了本次对话" : "⚠️ 复核：输出可能仍是模板或离题");

await server.close();
