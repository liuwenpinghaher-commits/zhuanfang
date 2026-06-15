/**
 * Live spike: find the correct DashScope endpoint for cosyvoice-v3-plus.
 * Run: node scripts/verify-tts.mjs
 *
 * Tests (in order):
 *   A1 — async-task via aigc multimodal-generation endpoint
 *   A2 — SpeechSynthesizer with X-DashScope-Async: enable header
 *   B  — WebSocket streaming (duplex inference protocol)
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";

// ── env loading (same pattern as verify-providers.mjs) ─────────────────────
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
const KEY = env.DASHSCOPE_API_KEY ?? env.BAILIAN_API_KEY ?? "";
const AUDIO_BASE = (env.BAILIAN_AUDIO_BASE_URL ?? "https://dashscope.aliyuncs.com").replace(/\/$/, "");
const MODEL = "cosyvoice-v3-plus";
const VOICES_TO_TRY = ["longyuan_v3", "longhua_v2", "longxiaochun_v2"];
const TEXT = "你好，这是一段测试。";
const POLL_MAX = 20;
const POLL_INTERVAL_MS = 2000;

if (!KEY) {
  console.error("ERROR: no DASHSCOPE_API_KEY found in .env.local");
  process.exit(1);
}

console.log(`\n=== DashScope CosyVoice Spike (key prefix: ${KEY.slice(0, 8)}…) ===`);
console.log(`audio base: ${AUDIO_BASE}`);
console.log(`model: ${MODEL}\n`);

// ── helpers ─────────────────────────────────────────────────────────────────
function authHeaders() {
  return {
    authorization: `Bearer ${KEY}`,
    "content-type": "application/json",
  };
}

async function pollTask(taskId) {
  for (let i = 0; i < POLL_MAX; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const r = await fetch(`${AUDIO_BASE}/api/v1/tasks/${encodeURIComponent(taskId)}`, {
      method: "GET",
      headers: authHeaders(),
      signal: AbortSignal.timeout(15000),
    });
    const txt = await r.text();
    if (!r.ok) return { ok: false, msg: `poll HTTP ${r.status}: ${txt.slice(0, 200)}` };
    let j;
    try { j = JSON.parse(txt); } catch { return { ok: false, msg: `poll parse error: ${txt.slice(0, 200)}` }; }
    const status = j.output?.task_status ?? j.task_status ?? j.status;
    console.log(`  [poll ${i + 1}/${POLL_MAX}] status=${status}`);
    if (status === "SUCCEEDED" || status === "succeeded") return { ok: true, json: j, status };
    if (status === "FAILED" || status === "failed" || status === "CANCELED") {
      return { ok: false, msg: `task ended with ${status}: ${txt.slice(0, 300)}` };
    }
  }
  return { ok: false, msg: `poll timed out after ${POLL_MAX} attempts` };
}

// ── A1: Async task via aigc/multimodal-generation ───────────────────────────
async function tryA1(voice) {
  console.log(`\n[A1] aigc/multimodal-generation  voice=${voice}`);
  const endpoint = `${AUDIO_BASE}/api/v1/services/aigc/multimodal-generation/generation`;
  const body = {
    model: MODEL,
    input: { text: TEXT },
    parameters: { voice, format: "mp3", sample_rate: 24000 },
  };
  let r, txt;
  try {
    r = await fetch(endpoint, {
      method: "POST",
      headers: { ...authHeaders(), "X-DashScope-Async": "enable" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    txt = await r.text();
  } catch (e) {
    console.log(`  NETWORK ERROR: ${e.message}`);
    return { ok: false, msg: `network: ${e.message}` };
  }
  console.log(`  submit HTTP ${r.status}: ${txt.slice(0, 300)}`);
  if (!r.ok) return { ok: false, msg: `HTTP ${r.status}: ${txt.slice(0, 300)}` };

  let j;
  try { j = JSON.parse(txt); } catch { return { ok: false, msg: `parse error: ${txt.slice(0, 200)}` }; }

  // If synchronous response with audio URL (some models skip async)
  const syncUrl = j.output?.audio?.url;
  if (syncUrl) {
    console.log(`  SYNC audio URL: ${syncUrl}`);
    return { ok: true, audioUrl: syncUrl, mode: "sync" };
  }

  const taskId = j.output?.task_id ?? j.request_id;
  if (!taskId) return { ok: false, msg: `no task_id in response: ${txt.slice(0, 300)}` };
  console.log(`  task_id=${taskId} — polling...`);

  const poll = await pollTask(taskId);
  if (!poll.ok) return { ok: false, msg: poll.msg };

  const audioUrl = poll.json?.output?.audio?.url
    ?? poll.json?.output?.results?.[0]?.url
    ?? poll.json?.results?.[0]?.url;
  console.log(`  poll result keys: ${JSON.stringify(Object.keys(poll.json?.output ?? {}))}`);
  console.log(`  audio_url=${audioUrl ?? "(not found)"}`);
  return { ok: Boolean(audioUrl), audioUrl, rawJson: JSON.stringify(poll.json).slice(0, 500) };
}

// ── A2: SpeechSynthesizer WITH X-DashScope-Async: enable ────────────────────
async function tryA2(voice) {
  console.log(`\n[A2] SpeechSynthesizer + async header  voice=${voice}`);
  const endpoint = `${AUDIO_BASE}/api/v1/services/audio/tts/SpeechSynthesizer`;
  const body = {
    model: MODEL,
    input: { text: TEXT, voice, format: "mp3", sample_rate: 24000 },
  };
  let r, txt;
  try {
    r = await fetch(endpoint, {
      method: "POST",
      headers: { ...authHeaders(), "X-DashScope-Async": "enable" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    txt = await r.text();
  } catch (e) {
    console.log(`  NETWORK ERROR: ${e.message}`);
    return { ok: false, msg: `network: ${e.message}` };
  }
  console.log(`  submit HTTP ${r.status}: ${txt.slice(0, 300)}`);
  if (!r.ok) return { ok: false, msg: `HTTP ${r.status}: ${txt.slice(0, 300)}` };

  let j;
  try { j = JSON.parse(txt); } catch { return { ok: false, msg: `parse error: ${txt.slice(0, 200)}` }; }

  const syncUrl = j.output?.audio?.url;
  if (syncUrl) {
    console.log(`  SYNC audio URL: ${syncUrl}`);
    return { ok: true, audioUrl: syncUrl, mode: "sync" };
  }

  const taskId = j.output?.task_id;
  if (!taskId) return { ok: false, msg: `no task_id: ${txt.slice(0, 300)}` };
  console.log(`  task_id=${taskId} — polling...`);

  const poll = await pollTask(taskId);
  if (!poll.ok) return { ok: false, msg: poll.msg };

  const audioUrl = poll.json?.output?.audio?.url
    ?? poll.json?.output?.results?.[0]?.url;
  console.log(`  poll result keys: ${JSON.stringify(Object.keys(poll.json?.output ?? {}))}`);
  console.log(`  audio_url=${audioUrl ?? "(not found)"}`);
  return { ok: Boolean(audioUrl), audioUrl, rawJson: JSON.stringify(poll.json).slice(0, 500) };
}

// ── A3: SpeechSynthesizer WITHOUT async (synchronous, original shape) ────────
async function tryA3(voice) {
  console.log(`\n[A3] SpeechSynthesizer synchronous (no async header)  voice=${voice}`);
  const endpoint = `${AUDIO_BASE}/api/v1/services/audio/tts/SpeechSynthesizer`;
  const body = {
    model: MODEL,
    input: { text: TEXT, voice, format: "mp3", sample_rate: 24000 },
  };
  let r, txt;
  try {
    r = await fetch(endpoint, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    txt = await r.text();
  } catch (e) {
    console.log(`  NETWORK ERROR: ${e.message}`);
    return { ok: false, msg: `network: ${e.message}` };
  }
  console.log(`  HTTP ${r.status}: ${txt.slice(0, 400)}`);
  if (!r.ok) return { ok: false, msg: `HTTP ${r.status}: ${txt.slice(0, 300)}` };
  let j;
  try { j = JSON.parse(txt); } catch { return { ok: false, msg: `parse error` }; }
  const audioUrl = j.output?.audio?.url;
  return { ok: Boolean(audioUrl), audioUrl, rawJson: txt.slice(0, 400) };
}

// ── B: WebSocket streaming ───────────────────────────────────────────────────
async function tryB(voice) {
  console.log(`\n[B] WebSocket duplex inference  voice=${voice}`);

  // Prefer ws npm package (Node EventEmitter API, supports .on());
  // global WebSocket (Node ≥ 22) uses EventTarget API — not compatible with .on() below.
  let WSImpl;
  try {
    const require = createRequire(import.meta.url);
    WSImpl = require("ws");
    console.log("  using ws npm package");
  } catch {
    if (typeof WebSocket !== "undefined") {
      console.log("  ws package unavailable; falling back to global WebSocket (EventTarget path)");
      WSImpl = null; // signals: use EventTarget branch below
    } else {
      return { ok: false, msg: "no WebSocket implementation available (no ws package, no global WS)" };
    }
  }

  const WS_URL = "wss://dashscope.aliyuncs.com/api-ws/v1/inference";
  const taskId = randomUUID();
  const audioChunks = [];
  let totalBytes = 0;

  return new Promise((resolve) => {
    let done = false;
    const finish = (result) => {
      if (!done) {
        done = true;
        try { ws.close(); } catch {}
        resolve(result);
      }
    };

    const wsHeaders = { Authorization: `Bearer ${KEY}` };
    // Global WebSocket doesn't take options directly; use ws-package form
    let ws;
    try {
      if (WSImpl) {
        // ws npm package: supports .on() EventEmitter API
        ws = new WSImpl(WS_URL, { headers: wsHeaders });
      } else {
        // global WebSocket (Node >= 22): EventTarget API, handled in addEventListener branch
        ws = new WebSocket(WS_URL); // NOTE: global WS doesn't support custom headers in constructor
      }
    } catch (e) {
      resolve({ ok: false, msg: `WS constructor error: ${e.message}` });
      return;
    }

    const timer = setTimeout(() => finish({ ok: false, msg: "WS timeout 30s" }), 30000);

    if (!WSImpl) {
      // EventTarget path (global WebSocket) — handled by addEventListener block below
      return;
    }
    ws.on("open", () => {
      console.log("  WS open — sending run-task");
      const runTask = {
        header: {
          action: "run-task",
          task_id: taskId,
          streaming: "duplex",
        },
        payload: {
          task_group: "audio",
          task: "tts",
          function: "SpeechSynthesizer",
          model: MODEL,
          parameters: {
            text_type: "PlainText",
            voice,
            format: "mp3",
            sample_rate: 24000,
          },
          input: {},
        },
      };
      ws.send(JSON.stringify(runTask));
    });

    ws.on("message", (data, isBinary) => {
      if (isBinary || (data instanceof Buffer && data.length > 0 && !isJsonLike(data))) {
        // Binary audio chunk
        totalBytes += data.length;
        audioChunks.push(data);
        return;
      }

      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      const event = msg?.header?.event ?? msg?.event ?? "";
      console.log(`  WS event: ${event}`);

      if (event === "task-started") {
        console.log("  task started — sending continue-task");
        const continueTask = {
          header: { action: "continue-task", task_id: taskId, streaming: "duplex" },
          payload: { input: { text: TEXT } },
        };
        ws.send(JSON.stringify(continueTask));

        // Then send finish-task
        setTimeout(() => {
          console.log("  sending finish-task");
          const finishTask = {
            header: { action: "finish-task", task_id: taskId, streaming: "duplex" },
            payload: { input: {} },
          };
          ws.send(JSON.stringify(finishTask));
        }, 200);
      } else if (event === "task-finished") {
        clearTimeout(timer);
        console.log(`  task-finished. total audio bytes: ${totalBytes}`);
        finish({ ok: totalBytes > 0, totalBytes, msg: `WS completed, ${totalBytes} bytes audio` });
      } else if (event === "task-failed") {
        clearTimeout(timer);
        const errCode = msg?.header?.error_code ?? "";
        const errMsg = msg?.header?.error_message ?? msg?.payload?.message ?? JSON.stringify(msg).slice(0, 400);
        finish({ ok: false, msg: `task-failed [${errCode}]: ${errMsg}` });
      }
    });

    ws.on("error", (err) => {
      clearTimeout(timer);
      finish({ ok: false, msg: `WS error: ${err.message ?? String(err)}` });
    });

    ws.on("close", (code, reason) => {
      clearTimeout(timer);
      if (!done) {
        finish({ ok: totalBytes > 0, totalBytes, msg: `WS closed ${code} ${reason}, bytes=${totalBytes}` });
      }
    });

    // For global WebSocket (EventTarget API) — only reached when WSImpl is null
    if (!WSImpl && typeof ws.addEventListener === "function") {
      ws.addEventListener("open", () => {
        console.log("  WS open (EventTarget) — sending run-task");
        const runTask = {
          header: { action: "run-task", task_id: taskId, streaming: "duplex" },
          payload: {
            task_group: "audio", task: "tts", function: "SpeechSynthesizer", model: MODEL,
            parameters: { text_type: "PlainText", voice, format: "mp3", sample_rate: 24000 },
            input: {},
          },
        };
        ws.send(JSON.stringify(runTask));
      });
      ws.addEventListener("message", (ev) => {
        const data = ev.data;
        if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
          const bytes = data instanceof ArrayBuffer ? data.byteLength : data.byteLength;
          totalBytes += bytes;
          return;
        }
        let msg;
        try { msg = JSON.parse(data); } catch { return; }
        const event = msg?.header?.event ?? "";
        console.log(`  WS event (EV): ${event}`);
        if (event === "task-started") {
          ws.send(JSON.stringify({ header: { action: "continue-task", task_id: taskId, streaming: "duplex" }, payload: { input: { text: TEXT } } }));
          setTimeout(() => ws.send(JSON.stringify({ header: { action: "finish-task", task_id: taskId, streaming: "duplex" }, payload: { input: {} } })), 200);
        } else if (event === "task-finished") {
          clearTimeout(timer);
          finish({ ok: totalBytes > 0, totalBytes, msg: `WS (EV) completed, ${totalBytes} bytes` });
        } else if (event === "task-failed") {
          clearTimeout(timer);
          finish({ ok: false, msg: `task-failed (EV): ${JSON.stringify(msg?.payload).slice(0, 200)}` });
        }
      });
      ws.addEventListener("error", (ev) => {
        clearTimeout(timer);
        finish({ ok: false, msg: `WS error (EV): ${ev.message ?? String(ev)}` });
      });
    }
  });
}

function isJsonLike(buf) {
  if (!buf || buf.length === 0) return false;
  const first = buf[0];
  return first === 0x7b || first === 0x5b; // '{' or '['
}

// ── main ─────────────────────────────────────────────────────────────────────
const results = {};

// A1: try first voice, then fallback
for (const voice of VOICES_TO_TRY) {
  const r = await tryA1(voice);
  results.a1 = { voice, ...r };
  if (r.ok || !r.msg.includes("InvalidParameter")) break;
}

// A2: SpeechSynthesizer + async header
for (const voice of VOICES_TO_TRY) {
  const r = await tryA2(voice);
  results.a2 = { voice, ...r };
  if (r.ok || !r.msg.includes("InvalidParameter")) break;
}

// A3: SpeechSynthesizer synchronous (no async)
for (const voice of VOICES_TO_TRY) {
  const r = await tryA3(voice);
  results.a3 = { voice, ...r };
  if (r.ok || !r.msg.includes("InvalidParameter")) break;
}

// B: WebSocket
for (const voice of VOICES_TO_TRY) {
  const r = await tryB(voice);
  results.b = { voice, ...r };
  if (r.ok || !r.msg?.includes("InvalidParameter")) break;
}

// ── Summary ──────────────────────────────────────────────────────────────────
console.log("\n\n=== SPIKE RESULTS SUMMARY ===");
for (const [k, v] of Object.entries(results)) {
  const badge = v.ok ? "OK " : "FAIL";
  const detail = v.ok
    ? (v.audioUrl ? `audio_url=${v.audioUrl}` : `bytes=${v.totalBytes}`)
    : v.msg;
  console.log(`[${badge}] ${k.toUpperCase()} (voice=${v.voice}): ${detail}`);
}

const anyWorks = Object.values(results).some((v) => v.ok);
const httpWorks = results.a1?.ok || results.a2?.ok || results.a3?.ok;
const wsWorks = results.b?.ok;
const networkBlocked =
  Object.values(results).every((v) => v.msg?.includes("network:") || v.msg?.includes("ENOTFOUND") || v.msg?.includes("ECONNREFUSED"));

console.log("\n--- Node WS availability ---");
console.log(`global WebSocket: ${typeof WebSocket !== "undefined" ? "YES (Node >= 22)" : "NO"}`);
try {
  const require = createRequire(import.meta.url);
  require.resolve("ws");
  console.log("ws npm package: YES");
} catch {
  console.log("ws npm package: NO");
}

if (networkBlocked) {
  console.log("\nSPIKE FINDING: NETWORK_BLOCKED — all calls failed with network errors (DNS/egress blocked)");
} else if (httpWorks) {
  const winner = results.a1?.ok ? results.a1 : results.a2?.ok ? results.a2 : results.a3;
  const endpointKey = results.a1?.ok ? "A1 (aigc/multimodal-generation)" : results.a2?.ok ? "A2 (SpeechSynthesizer+async)" : "A3 (SpeechSynthesizer sync)";
  console.log(`\nSPIKE FINDING: ASYNC_HTTP_WORKS via ${endpointKey}, voice=${winner.voice}, audio_url=${winner.audioUrl}`);
  console.log("RECOMMENDED INTEGRATION: drop-in endpoint swap — update createBailianPodcastAudioClient to use the winning endpoint/header combination; poll task if needed; near-zero structural change.");
} else if (wsWorks) {
  console.log(`\nSPIKE FINDING: WEBSOCKET_WORKS — ${results.b.totalBytes} bytes audio received via duplex WS, voice=${results.b.voice}`);
  console.log("RECOMMENDED INTEGRATION: full WS+audio-storage client (stream binary chunks → buffer → upload to storage → return URL); larger integration but proven to work.");
} else {
  console.log("\nSPIKE FINDING: NEITHER — all attempts failed. See per-attempt errors above.");
  console.log("RECOMMENDED INTEGRATION: honest-disable CosyVoice TTS until correct endpoint/key-permissions confirmed.");
}
