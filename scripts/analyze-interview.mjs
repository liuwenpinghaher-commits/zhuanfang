// Deep quality analysis of one completed interview.
// Pulls the finalized modules (note / assets / memory candidates / reviews) from the REAL
// running system's state, computes hard metrics, and runs an LLM judge against the 张小珺
// 《商业访谈录》 rubric. Usage: node scripts/analyze-interview.mjs <interviewJson> <outReport>
import { readFileSync, writeFileSync } from "node:fs";

function loadEnv(url) {
  const env = {};
  try { for (const l of readFileSync(url, "utf8").split(/\r?\n/)) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !l.trim().startsWith("#")) env[m[1]] = m[2]; } } catch {}
  return env;
}
const env = loadEnv(new URL("../.env.local", import.meta.url));
const KEY = env.DASHSCOPE_API_KEY;
const CHAT_URL = (env.BAILIAN_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1") + "/chat/completions";
const JUDGE_MODEL = env.JUDGE_MODEL || "qwen-plus";
const API = env.PRODUCT_API_BASE || "http://127.0.0.1:3210";

const interviewFile = process.argv[2];
const outReport = process.argv[3];
const data = JSON.parse(readFileSync(interviewFile, "utf8"));

async function judge(system, user, { max_tokens = 1200 } = {}) {
  for (let a = 0; a < 4; a++) {
    try {
      const res = await fetch(CHAT_URL, { method: "POST", headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
        body: JSON.stringify({ model: JUDGE_MODEL, messages: [{ role: "system", content: system }, { role: "user", content: user }], temperature: 0.2, max_tokens, response_format: { type: "json_object" } }),
        signal: AbortSignal.timeout(90000) });
      if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 200)}`);
      const j = await res.json();
      return JSON.parse(j.choices[0].message.content);
    } catch (e) { if (a === 3) throw e; await new Promise((r) => setTimeout(r, 1500 * (a + 1))); }
  }
}

const RUBRIC = `你是《商业访谈录》(张小珺)的访谈质量评审。评判"主持人提问"的水准。优秀的提问特征：
1) 紧承受访者上一句，用其原话/具体词推进；2) 把抽象判断钉成一个具体时刻(谁/何时/哪句话/哪个场景)；
3) 简短锋利，不啰嗦不复述；4) 不重复、不原地打转，能层层深入；5) 会挑战前提、追背后机制、追代价与反例；
6) 能顺着情绪与离题线索走，制造张力与"人味"。
对每一维度打 0-10 分，给出 total(0-60)，并指出最严重的 3 个问题(weakest)与 1 条最该先修的根因(rootCause)。
严格只输出 JSON：{"specificity":n,"builds_on":n,"sharp_concise":n,"non_repetition":n,"challenge_mechanism":n,"humanity_tension":n,"total":n,"verdict":"...","weakest":["..."],"rootCause":"..."}`;

(async () => {
  // hard metrics
  const assistantTurns = data.transcript.filter((t) => t.role === "assistant").map((t) => t.content);
  const userTurns = data.transcript.filter((t) => t.role === "user").map((t) => t.content);
  const qLens = assistantTurns.map((q) => q.length);
  const avgQ = Math.round(qLens.reduce((a, b) => a + b, 0) / Math.max(1, qLens.length));
  // crude repetition: fraction of questions whose first 10 chars repeat an earlier one
  const seen = new Set(); let repeats = 0;
  for (const q of assistantTurns) { const k = q.slice(0, 12); if (seen.has(k)) repeats++; seen.add(k); }
  // template-leak / banned: parentheses asides that should never appear in a question
  const asideLeak = assistantTurns.filter((q) => /（[^）]*）|\([^)]*\)/.test(q)).length;

  // fetch finalized modules from REAL state
  const state = await (await fetch(`${API}/api/state`, { signal: AbortSignal.timeout(30000) })).json();
  const note = (state.notes || []).find((n) => n.sessionId === data.sessionId);
  const recentCandidates = (state.memoryCandidates || []).slice(0, 12);
  const assetCounts = {
    points: state.points?.length || 0, questions: state.questions?.length || 0,
    decisions: state.decisions?.length || 0, debts: state.debts?.length || 0, themes: state.themes?.length || 0,
    memoryCandidates: state.memoryCandidates?.length || 0, reviews: (state.reviews || []).length
  };
  const degradedEvents = (state.aiRunEvents || []).filter((e) => e.status === "degraded" || e.status === "failed").slice(0, 20);

  // LLM judge on interviewer questions (sample of paired exchanges to keep prompt bounded)
  const sample = data.transcript.slice(0, 60).map((t) => `${t.role === "assistant" ? "主持人" : "受访者"}：${t.content}`).join("\n");
  const interviewScore = await judge(RUBRIC, `以下是访谈前半段对话。请评判主持人提问质量。\n\n${sample}`);

  // LLM judge on note + assets substance
  const noteText = note ? JSON.stringify({ summary: note.summary, keyQuote: note.keyQuote, saidTrack: note.saidTrack, learnedTrack: note.learnedTrack }, null, 0) : "(无 note)";
  const assetSample = JSON.stringify({
    points: (state.points || []).slice(0, 6).map((p) => p.text || p.title || p),
    decisions: (state.decisions || []).slice(0, 4).map((p) => p.text || p.title || p),
    themes: (state.themes || []).slice(0, 6).map((p) => ({ name: p.name, summary: p.summary })),
    debts: (state.debts || []).slice(0, 4).map((p) => p.text || p.title || p),
    candidates: recentCandidates.map((c) => c.text)
  }, null, 0);
  const assetScore = await judge(
    `你评判访谈结束后系统自动沉淀的"认知资产"质量。好资产应：具体、源自真实对话、有信息量、不空泛不套话。对 note(双轨笔记)与 assets 各打 0-10，给 total(0-20)，指出最弱项 weakest[] 与根因 rootCause。严格只输出 JSON：{"note_quality":n,"assets_quality":n,"total":n,"verdict":"...","weakest":["..."],"rootCause":"..."}`,
    `双轨笔记：${noteText}\n\n沉淀资产样本：${assetSample}`
  );

  const report = {
    persona: data.persona, sessionId: data.sessionId,
    hardMetrics: {
      chars: data.chars, targetMet: data.chars >= 20000, turns: data.turns, elapsedMin: data.elapsedMin,
      minutesMet: data.elapsedMin >= 30, interviewerQuestions: assistantTurns.length, avgQuestionLen: avgQ,
      repeatedQuestionPrefixes: repeats, asideLeakInQuestions: asideLeak,
      driverDegraded: data.degraded, stateDegradedEvents: degradedEvents.length
    },
    assetCounts,
    interviewQuality: interviewScore,
    assetQuality: assetScore,
    degradedEvents: degradedEvents.map((e) => ({ workflow: e.workflow, status: e.status, reason: e.degradedReason }))
  };
  writeFileSync(outReport, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({
    persona: data.persona.name, chars: data.chars, turns: data.turns, min: data.elapsedMin,
    interviewTotal: `${interviewScore.total}/60`, assetTotal: `${assetScore.total}/20`,
    avgQ, repeats, asideLeak, degraded: data.degraded,
    interviewRoot: interviewScore.rootCause, assetRoot: assetScore.rootCause
  }, null, 2));
})().catch((e) => { console.error("ANALYZE ERROR:", e.message); process.exit(1); });
