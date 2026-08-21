// End-to-end real-interview driver.
// The INTERVIEWER is the real running system (POST /api/interview-sessions/:id/turns →
// qwen-plus-character). The INTERVIEWEE is an LLM playing a rich persona (text simulation).
// Drives a session until >= targetChars, then /end (finalize), and dumps everything for
// quality analysis. Usage: node scripts/run-interview.mjs <personaFile> <outFile> [targetChars]
import { readFileSync, writeFileSync } from "node:fs";
import { assertEvalProcessSafe, assertPurgeAllowed, defaultEvalApiBase } from "./eval/lib/purge-guard.mjs";

try {
  assertEvalProcessSafe(process.env);
} catch (err) {
  console.error(err.message);
  process.exit(err.exitCode === 2 ? 2 : 1);
}

function loadEnv(url) {
  const env = {};
  try {
    for (const line of readFileSync(url, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !line.trim().startsWith("#")) env[m[1]] = m[2];
    }
  } catch {}
  return env;
}
const fileEnv = loadEnv(new URL("../.env.local", import.meta.url));
const env = { ...fileEnv, ...process.env };
const KEY = env.DASHSCOPE_API_KEY || env.BAILIAN_API_KEY;
const CHAT_URL = (env.BAILIAN_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1") + "/chat/completions";
const INTERVIEWEE_MODEL = env.INTERVIEWEE_MODEL || env.BAILIAN_GENERAL_MODEL || "qwen-plus";
const API = defaultEvalApiBase({ ...env, EVAL_API_BASE: process.env.EVAL_API_BASE || process.env.PRODUCT_API_BASE || env.PRODUCT_API_BASE });

const personaFile = process.argv[2];
const outFile = process.argv[3];
const TARGET_CHARS = Number(process.argv[4] || 20000);
const MAX_TURNS = Number(process.env.EVAL_MAX_USER_TURNS || 140);
let sessionCookie = "";
const persona = JSON.parse(readFileSync(personaFile, "utf8"));

const log = (...a) => process.stdout.write(a.join(" ") + "\n");

async function chat(messages, { temperature = 0.85, max_tokens = 900 } = {}) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(CHAT_URL, {
        method: "POST",
        headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
        body: JSON.stringify({ model: INTERVIEWEE_MODEL, messages, temperature, max_tokens }),
        signal: AbortSignal.timeout(60000)
      });
      if (!res.ok) throw new Error(`chat ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const j = await res.json();
      const content = j.choices?.[0]?.message?.content?.trim();
      if (content) return content;
      throw new Error("empty chat content");
    } catch (e) {
      if (attempt === 3) throw e;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
}

function cookieHeader() {
  const h = { "content-type": "application/json" };
  if (sessionCookie) h.cookie = `zf_session=${sessionCookie}`;
  return h;
}

function captureCookie(res) {
  const raw = res.headers.get("set-cookie") ?? "";
  const m = raw.match(/zf_session=([^;]+)/);
  if (m) sessionCookie = decodeURIComponent(m[1]);
}

async function api(path, body, { retries = 4, timeoutMs = 300000 } = {}) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(`${API}${path}`, {
        method: "POST",
        headers: cookieHeader(),
        body: JSON.stringify(body),
        // Client timeout must cover the product write-slot ceiling (budget + slack ≥ 480s).
        signal: AbortSignal.timeout(timeoutMs)
      });
      captureCookie(res);
      if (!res.ok) throw new Error(`api ${path} ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return await res.json();
    } catch (e) {
      if (attempt === retries - 1) throw e;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
}

async function loginEvalUser() {
  const user = process.env.EVAL_USERNAME;
  const pass = process.env.EVAL_PASSWORD;
  if (!user || !pass) {
    throw Object.assign(new Error(JSON.stringify({ event: "eval_purge_blocked", reason: "eval_session_login_required" })), { exitCode: 2 });
  }
  const login = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: user, password: pass }),
    signal: AbortSignal.timeout(20000)
  });
  captureCookie(login);
  if (!login.ok || !sessionCookie) {
    throw Object.assign(new Error(JSON.stringify({ event: "eval_purge_blocked", reason: "eval_session_login_required" })), { exitCode: 2 });
  }
  return user;
}

function intervieweeSystem() {
  return [
    `你是「${persona.name}」，${persona.role}。正在接受一档高水准深度商业访谈（对标张小珺《商业访谈录》）。`,
    `你的背景：${persona.bio}`,
    `你的核心观点/经历（自然融入回答，不要罗列）：${persona.stances.join("；")}`,
    `说话风格：${persona.style}`,
    `【身份铁律】你自始至终都是${persona.name}，只能基于你这个身份的真实领域（${persona.domain}）作答。无论主持人把话题引向哪里，都要从你这个领域的真实经历回答；如果问题超出你的领域，就坦诚地把它拉回你熟悉的领域，绝不要凭空切换成别的职业/行业（比如医疗、客服、保险等与你无关的领域）。每一段回答都必须和「${persona.domain}」直接相关。`,
    `回答要求：第一人称、口语化、具体。多讲具体的人、事、时间、数字、转折、内心活动和真实细节；遇到抽象问题要落到一个具体场景或时刻。每次回答 250-500 字，不要复述主持人的问题，不要用"作为一名…"开头，直接说内容。偶尔可以反问或主动延展一个新线索。`
  ].join("\n");
}

async function intervieweeReply(history, question) {
  const messages = [{ role: "system", content: intervieweeSystem() }];
  // include recent dialogue as context (host=user asks, you=assistant answers)
  for (const t of history.slice(-12)) {
    messages.push({ role: t.role === "assistant" ? "user" : "assistant", content: t.content });
  }
  messages.push({ role: "user", content: `主持人问：${question}` });
  return chat(messages);
}

(async () => {
  const t0 = Date.now();
  log(`\n=== 访谈开始：${persona.name}（${persona.role}）目标 ${TARGET_CHARS} 字 ===`);
  // Clean, isolated state per interview: purge seed/demo + any prior interview so this
  // session's guide, memory recall, and finalized assets come PURELY from this conversation.
  const evalUser = process.env.EVAL_USERNAME;
  if (evalUser && process.env.EVAL_PASSWORD) {
    const user = await loginEvalUser();
    log(`  logged in as ${user}`);
  }
  if (process.env.EVAL_ALLOW_PURGE === "1") {
    const user = evalUser || (await loginEvalUser());
    assertPurgeAllowed({
      env: process.env,
      meUsername: user,
      wrappingProven: process.env.EVAL_WRAPPING_PROVEN === "1"
    });
    await api("/api/state/purge", { confirm: "PURGE_PERSONAL_DATA", scope: "all" });
    log("  state purged → clean slate");
  } else {
    log("  skip purge (EVAL_ALLOW_PURGE!=1; SKIP_PURGE is retired)");
  }
  const created = await api("/api/interview-sessions", { mode: "daily", topicHint: persona.topicHint });
  const id = created.session.id;
  log(`session: ${id}`);

  const transcript = []; // {role, content}
  let chars = 0;
  let degraded = 0;
  const degradedReasons = [];

  // Seed: interviewee opens (the reference opens with the guest making a statement).
  let nextQuestion = persona.opening || "请先做个自我介绍，并讲讲你最近在想的一件事。";
  let firstUserSeed = persona.seed;

  for (let turn = 0; turn < MAX_TURNS && chars < TARGET_CHARS; turn++) {
    let reply;
    if (turn === 0 && firstUserSeed) {
      reply = firstUserSeed;
    } else {
      reply = await intervieweeReply(transcript, nextQuestion);
    }
    transcript.push({ role: "user", content: reply });
    chars += reply.length;

    const r = await api(`/api/interview-sessions/${id}/turns`, { content: reply });
    const sess = r.session;
    const lastAssistant = [...sess.turns].reverse().find((t) => t.role === "assistant");
    nextQuestion = lastAssistant?.content || "能再具体说说吗？";
    transcript.push({ role: "assistant", content: nextQuestion });
    chars += nextQuestion.length;
    if (r.degradedReason) { degraded++; degradedReasons.push(`#${turn}: ${r.degradedReason}`); }
    const mins = ((Date.now() - t0) / 60000).toFixed(1);
    log(`  turn ${turn}: ${chars} 字 / ${mins} 分钟${r.degradedReason ? "  ⚠DEGRADED" : ""}`);
  }

  let ended = null;
  let endError = null;
  let endAttempts = 0;
  let endMs = null;
  const result = () => ({
    persona: { name: persona.name, role: persona.role },
    sessionId: id,
    chars,
    turns: transcript.length,
    elapsedMin: Number(((Date.now() - t0) / 60000).toFixed(1)),
    degraded,
    degradedReasons,
    transcript,
    ended,
    endError,
    endAttempts,
    endMs
  });
  writeFileSync(outFile, JSON.stringify(result(), null, 2));
  log(`  transcript saved (${transcript.length} 轮, ${chars} 字) → ${outFile}`);

  log(`  /end finalize…`);
  const endStarted = Date.now();
  for (let i = 0; i < 2; i++) {
    endAttempts += 1;
    try {
      ended = await api(`/api/interview-sessions/${id}/end`, {}, { retries: 1, timeoutMs: 520000 });
      endError = null;
      break;
    } catch (e) {
      endError = e.message;
      log(`  /end attempt ${endAttempts} failed: ${endError}`);
    }
  }
  endMs = Date.now() - endStarted;
  writeFileSync(outFile, JSON.stringify(result(), null, 2));
  log(`\n=== 完成：${chars} 字 / ${transcript.length} 轮 / ${result().elapsedMin} 分钟 / 降级 ${degraded} 次 / 收工 ${endMs}ms / 尝试 ${endAttempts} 次${endError ? " / 未归档" : ""} ===`);
  log(`输出：${outFile}`);
  log("  keep this file as-is in the sample dir (ended/endAttempts/endMs). do not slim.");
  if (endError) process.exit(1);
})().catch((e) => { console.error("DRIVER ERROR:", e.message); process.exit(e.exitCode === 2 ? 2 : 1); });
