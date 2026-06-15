// One-shot provider verification against the real DashScope / AnySearch keys.
// Run: node scripts/verify-providers.mjs
// Reads keys from .env.local. Prints a model x reality table. Safe to delete after.
import { readFileSync } from "node:fs";
import WebSocket from "ws";

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

const env = loadEnv(new URL("../.env.local", import.meta.url));
const KEY = env.DASHSCOPE_API_KEY;
const ANY_KEY = env.ANYSEARCH_API_KEY;
const BJ = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const INTL = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";
const AUDIO = "https://dashscope.aliyuncs.com";

const results = [];
const rec = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✅" : "❌"} ${name.padEnd(36)} ${detail}`);
};

async function chat(base, model, json = false) {
  const t0 = Date.now();
  const body = {
    model,
    messages: [
      ...(model.includes("character") ? [{ role: "system", content: "你是一个简洁的助手。" }] : []),
      { role: "user", content: json ? '返回JSON：{"ok":true,"n":3}' : "用一句话说你好" }
    ],
    max_tokens: 60,
    ...(json ? { response_format: { type: "json_object" } } : {})
  };
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000)
    });
    const txt = await res.text();
    const ms = Date.now() - t0;
    if (!res.ok) return { ok: false, ms, msg: `HTTP ${res.status} ${txt.slice(0, 160)}` };
    let content = "";
    try { content = JSON.parse(txt).choices?.[0]?.message?.content ?? ""; } catch {}
    return { ok: true, ms, msg: `${ms}ms ｜ ${content.replace(/\s+/g, " ").slice(0, 50)}` };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, msg: String(e?.message || e).slice(0, 160) };
  }
}

async function anysearch() {
  const t0 = Date.now();
  try {
    const res = await fetch("https://api.anysearch.com/v1/search", {
      method: "POST",
      headers: { authorization: `Bearer ${ANY_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ query: "AI 产品 2026 趋势", max_results: 3, content_types: ["web", "news"], language: "zh-CN" }),
      signal: AbortSignal.timeout(20000)
    });
    const txt = await res.text();
    const ms = Date.now() - t0;
    if (!res.ok) return { ok: false, msg: `HTTP ${res.status} ${txt.slice(0, 160)}` };
    let n = 0;
    try { n = (JSON.parse(txt).data?.results ?? []).length; } catch {}
    return { ok: n > 0, msg: `${ms}ms ｜ ${n} 条结果` };
  } catch (e) {
    return { ok: false, msg: String(e?.message || e).slice(0, 160) };
  }
}

async function tts(model) {
  const t0 = Date.now();
  try {
    const res = await fetch(`${AUDIO}/api/v1/services/audio/tts/SpeechSynthesizer`, {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ model, input: { text: "你好", voice: "longyuan_v3", format: "mp3", sample_rate: 24000 } }),
      signal: AbortSignal.timeout(20000)
    });
    const txt = await res.text();
    const ms = Date.now() - t0;
    if (!res.ok) return { ok: false, msg: `HTTP ${res.status} ${txt.slice(0, 140)}` };
    let url = "";
    try { url = JSON.parse(txt).output?.audio?.url ?? ""; } catch {}
    return { ok: Boolean(url), msg: url ? `${ms}ms ｜ 有 audio url` : `${ms}ms ｜ 200 但无 url: ${txt.slice(0,120)}` };
  } catch (e) {
    return { ok: false, msg: String(e?.message || e).slice(0, 140) };
  }
}

function realtimeWs(model) {
  return new Promise((resolve) => {
    const url = `wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=${encodeURIComponent(model)}`;
    let done = false;
    const finish = (ok, msg) => { if (!done) { done = true; try { ws.close(); } catch {} resolve({ ok, msg }); } };
    const t0 = Date.now();
    const ws = new WebSocket(url, { headers: { authorization: `Bearer ${KEY}` } });
    const timer = setTimeout(() => finish(false, "握手/事件超时 12s"), 12000);
    ws.on("open", () => { /* wait for session.created */ });
    ws.on("message", (data) => {
      clearTimeout(timer);
      let type = "";
      try { type = JSON.parse(data.toString()).type ?? ""; } catch {}
      finish(true, `${Date.now() - t0}ms ｜ 首事件 ${type || "(收到)"}`);
    });
    ws.on("unexpected-response", (_req, res) => { clearTimeout(timer); finish(false, `HTTP ${res.statusCode}`); });
    ws.on("error", (err) => { clearTimeout(timer); finish(false, String(err?.message || err).slice(0, 140)); });
  });
}

console.log(`\n=== Provider 实测（key 前缀 ${String(KEY).slice(0, 6)}… / anysearch ${String(ANY_KEY).slice(0, 8)}…）===\n`);
console.log("— 文字 chat completions（北京 compatible-mode）—");
for (const m of ["qwen-plus-character", "qwen-plus", "qwen3.7-plus", "qwen-max", "qwen3.5-omni-plus"]) {
  const r = await chat(BJ, m);
  rec(`chat:${m}`, r.ok, r.msg);
}
console.log("\n— JSON 模式（Phase 2 依赖）—");
{
  const r = await chat(BJ, "qwen-plus", true);
  rec("chat:qwen-plus[json]", r.ok, r.msg);
}
console.log("\n— 区域回退探测（若上面 character 失败才有意义）—");
{
  const r = await chat(INTL, "qwen-plus-character-ja");
  rec("chat:intl/qwen-plus-character-ja", r.ok, r.msg);
}
console.log("\n— AnySearch 联网搜索 —");
{ const r = await anysearch(); rec("anysearch:/v1/search", r.ok, r.msg); }
console.log("\n— TTS（CosyVoice）—");
{ const r = await tts("cosyvoice-v3-plus"); rec("tts:cosyvoice-v3-plus", r.ok, r.msg); }
console.log("\n— 实时语音 WS 握手 —");
for (const m of ["qwen3.5-omni-plus-realtime", "qwen3-omni-flash-realtime"]) {
  const r = await realtimeWs(m);
  rec(`realtime:${m}`, r.ok, r.msg);
}

console.log(`\n=== 汇总：${results.filter((r) => r.ok).length}/${results.length} 通过 ===`);
const fail = results.filter((r) => !r.ok);
if (fail.length) console.log("失败项：", fail.map((r) => r.name).join(", "));
