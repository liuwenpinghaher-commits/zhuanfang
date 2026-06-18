// One-shot: does DashScope omni-realtime accept `turn_detection.create_response:false`
// for a text-only ASR session? Run: node scripts/spike-asr-create-response.mjs
// Reads DASHSCOPE_API_KEY from .env.local. Safe to delete after.
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
const MODEL = "qwen3.5-omni-plus-realtime";
const URL_WS = `wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=${encodeURIComponent(MODEL)}`;

function trySession(label, sessionUpdate) {
  return new Promise((resolve) => {
    const ws = new WebSocket(URL_WS, { headers: { authorization: `Bearer ${KEY}` } });
    let done = false;
    const events = [];
    const finish = (verdict, detail) => {
      if (done) return;
      done = true;
      try { ws.close(); } catch {}
      resolve({ label, verdict, detail, events });
    };
    const timer = setTimeout(() => finish("TIMEOUT", `12s 内没等到 session.updated/error；收到的事件: ${events.join(", ") || "(无)"}`), 12000);
    ws.on("open", () => ws.send(JSON.stringify(sessionUpdate)));
    ws.on("message", (data) => {
      let msg = {};
      try { msg = JSON.parse(data.toString()); } catch { return; }
      const t = msg.type || "";
      events.push(t);
      if (t === "session.updated") {
        clearTimeout(timer);
        // confirm the server echoed our turn_detection back
        const td = msg.session?.turn_detection;
        finish("ACCEPTED", `session.updated ｜ 服务端回显 turn_detection=${JSON.stringify(td)}`);
      } else if (t === "error") {
        clearTimeout(timer);
        finish("REJECTED", `error ｜ ${JSON.stringify(msg.error || msg).slice(0, 240)}`);
      }
      // ignore session.created (always first) and others
    });
    ws.on("unexpected-response", (_q, res) => { clearTimeout(timer); finish("HTTP_ERR", `HTTP ${res.statusCode}`); });
    ws.on("error", (e) => { clearTimeout(timer); finish("WS_ERR", String(e?.message || e).slice(0, 200)); });
  });
}

const base = {
  modalities: ["text"],
  input_audio_format: "pcm",
  instructions: "你是转写器，只转写不回应。",
  turn_detection: { type: "server_vad", threshold: 0.5, silence_duration_ms: 600 }
};

const cases = [
  ["A. 当前 cascade 配置（无 create_response）", { type: "session.update", session: { ...base } }],
  ["B. 加 create_response:false", { type: "session.update", session: { ...base, turn_detection: { ...base.turn_detection, create_response: false } } }]
];

console.log(`\n=== omni ASR session 配置 spike（key ${String(KEY).slice(0,6)}…）===\n`);
for (const [label, su] of cases) {
  const r = await trySession(label, su);
  const icon = r.verdict === "ACCEPTED" ? "✅" : r.verdict === "REJECTED" ? "❌" : "⚠️";
  console.log(`${icon} ${r.label}`);
  console.log(`   裁决: ${r.verdict}`);
  console.log(`   细节: ${r.detail}`);
  console.log(`   事件序列: ${r.events.join(" → ") || "(无)"}\n`);
}
