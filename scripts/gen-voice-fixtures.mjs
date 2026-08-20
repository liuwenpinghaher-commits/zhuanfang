#!/usr/bin/env node
// 生成「办法 B」用的语音 fixture:把访谈剧本逐轮用项目 CosyVoice TTS 合成 16kHz 单声道 PCM,
// 句内分段拼 0.3s 静音(<server_vad 1.5s,避免轮内被误切成多 turn),输出 base64 JSON 供
// Playwright fakeMic 注入。轮与轮之间的"长静音断句"由测试时序控制(speak 一轮→等回应→下一轮)。
//
// 用法:
//   node scripts/gen-voice-fixtures.mjs [剧本.json] [输出.json]
//   剧本.json 形如 [{"content":"一轮发言…"}, …](缺省用内置自检短句,只验证链路)
//   输出缺省 tests/e2e/fixtures/voice/sample.json
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import WebSocket from "ws";

const SR = 16000;             // 必须 == cascadedAsrSource 的 AudioContext({sampleRate:16000})
const INTRA_SILENCE_MS = 300; // 轮内句间静音(< server_vad silence_duration_ms 1500)
const SEG_MAX = 80;           // 单次 continue-task 文本上限(保守分段,避免超长)
const WS_URL = "wss://dashscope.aliyuncs.com/api-ws/v1/inference";

function loadEnv(url) {
  const e = {};
  try { for (const l of readFileSync(url, "utf8").split(/\r?\n/)) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !l.trim().startsWith("#")) e[m[1]] = m[2]; } } catch {}
  return e;
}
const fileEnv = loadEnv(new URL("../.env.local", import.meta.url));
const KEY = (
  process.env.DASHSCOPE_API_KEY ||
  process.env.BAILIAN_API_KEY ||
  fileEnv.DASHSCOPE_API_KEY ||
  fileEnv.BAILIAN_API_KEY ||
  ""
).trim();
if (!KEY) { console.error("缺 DASHSCOPE_API_KEY/BAILIAN_API_KEY"); process.exit(1); }

const silence = (ms) => Buffer.alloc(Math.round((ms / 1000) * SR) * 2); // s16le mono 全 0

function splitSegments(text) {
  const out = [];
  let buf = "";
  for (const ch of text.trim()) {
    buf += ch;
    if (/[。！？!?；;\n]/.test(ch) && buf.trim().length >= 12) { out.push(buf.trim()); buf = ""; }
    else if (buf.length >= SEG_MAX) { out.push(buf.trim()); buf = ""; }
  }
  if (buf.trim()) out.push(buf.trim());
  return out.length ? out : [text.trim()];
}

function ttsSegment(text, tag) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL, { headers: { Authorization: `Bearer ${KEY}` } });
    const taskId = `gen-${tag}-${Date.now() % 100000}`;
    const chunks = [];
    let done = false;
    const finish = (buf, err) => { if (done) return; done = true; try { ws.close(); } catch {} err ? reject(err) : resolve(buf); };
    const timer = setTimeout(() => finish(null, new Error("tts timeout")), 30000);
    const params = { text_type: "PlainText", voice: "longanyang", format: "pcm", sample_rate: SR };
    ws.on("open", () => ws.send(JSON.stringify({ header: { action: "run-task", task_id: taskId, streaming: "duplex" }, payload: { task_group: "audio", task: "tts", function: "SpeechSynthesizer", model: "cosyvoice-v3-plus", parameters: params, input: {} } })));
    ws.on("message", (data, isBinary) => {
      if (isBinary || (Buffer.isBuffer(data) && data[0] !== 0x7b)) { chunks.push(Buffer.from(data)); return; }
      let msg = {}; try { msg = JSON.parse(data.toString()); } catch { chunks.push(Buffer.from(data)); return; }
      const ev = msg.header?.event;
      if (ev === "task-started") {
        ws.send(JSON.stringify({ header: { action: "continue-task", task_id: taskId, streaming: "duplex" }, payload: { input: { text } } }));
        ws.send(JSON.stringify({ header: { action: "finish-task", task_id: taskId, streaming: "duplex" }, payload: { input: {} } }));
      } else if (ev === "task-finished") { clearTimeout(timer); finish(chunks.length ? Buffer.concat(chunks) : null, chunks.length ? null : new Error("no audio")); }
      else if (ev === "task-failed") { clearTimeout(timer); finish(null, new Error(`${msg.header?.error_code}: ${String(msg.header?.error_message).slice(0, 80)}`)); }
    });
    ws.on("error", (e) => { clearTimeout(timer); finish(null, e); });
  });
}

async function ttsUtterance(text, idx) {
  const segs = splitSegments(text);
  const parts = [];
  for (let s = 0; s < segs.length; s++) {
    parts.push(await ttsSegment(segs[s], `${idx}-${s}`));
    if (s < segs.length - 1) parts.push(silence(INTRA_SILENCE_MS));
  }
  return Buffer.concat(parts);
}

const [inPath, outPath = "tests/e2e/fixtures/voice/sample.json"] = process.argv.slice(2);
const rounds = inPath
  ? JSON.parse(readFileSync(inPath, "utf8")).map((x) => (typeof x === "string" ? x : x.content || x.text)).filter(Boolean)
  : ["你好,我想聊聊远程办公。我认为远程办公从根本上提升了团队效率。", "不过最近我有相反的感受,我开始觉得面对面其实不可替代。"];

console.log(`生成 ${rounds.length} 轮语音(16kHz mono s16le)…`);
const utterances = [];
for (let i = 0; i < rounds.length; i++) {
  const pcm = await ttsUtterance(rounds[i], i);
  const durationMs = Math.round((pcm.length / 2 / SR) * 1000);
  utterances.push({ text: rounds[i].slice(0, 60), pcmBase64: pcm.toString("base64"), durationMs });
  console.log(`  [${i}] ${durationMs}ms ${pcm.length}B "${rounds[i].slice(0, 22)}…"`);
}
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify({ sampleRate: SR, channels: 1, format: "s16le", utterances }));
console.log(`✅ ${utterances.length} 轮 → ${outPath}`);
