// Does CosyVoice cosyvoice-v3-plus streaming support format:"pcm"? Compare mp3 vs pcm.
// Run: node scripts/spike-tts-pcm.mjs  — reads DASHSCOPE_API_KEY from .env.local.
import { readFileSync } from "node:fs";
import WebSocket from "ws";
// F-07:key 前缀无验证价值却增加凭据识别面,日志只回答"配置了没有"
import { describeKeyStatus } from "./lib/redact.mjs";

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
const URL_WS = "wss://dashscope.aliyuncs.com/api-ws/v1/inference";

function synth(format) {
  return new Promise((resolve) => {
    const ws = new WebSocket(URL_WS, { headers: { Authorization: `Bearer ${KEY}` } });
    const taskId = `spike-${format}-${Math.abs((format + KEY).split("").reduce((a, c) => a * 31 + c.charCodeAt(0) | 0, 7))}`;
    let bytes = 0, frames = 0, done = false, firstAudioMs = 0;
    const t0 = Date.now();
    const finish = (verdict, detail) => { if (done) return; done = true; try { ws.close(); } catch {} resolve({ format, verdict, detail, bytes, frames, firstAudioMs }); };
    const timer = setTimeout(() => finish(bytes > 0 ? "PARTIAL" : "TIMEOUT", `${frames}帧/${bytes}B`), 20000);
    ws.on("open", () => {
      ws.send(JSON.stringify({
        header: { action: "run-task", task_id: taskId, streaming: "duplex" },
        payload: { task_group: "audio", task: "tts", function: "SpeechSynthesizer", model: "cosyvoice-v3-plus",
          parameters: { text_type: "PlainText", voice: "longanyang", format, sample_rate: 24000 }, input: {} }
      }));
    });
    ws.on("message", (data, isBinary) => {
      if (isBinary || (Buffer.isBuffer(data) && data[0] !== 0x7b)) { bytes += data.length; frames++; if (!firstAudioMs) firstAudioMs = Date.now() - t0; return; }
      let msg = {};
      try { msg = JSON.parse(data.toString()); } catch { bytes += data.length; frames++; return; }
      const ev = msg.header?.event;
      if (ev === "task-started") {
        ws.send(JSON.stringify({ header: { action: "continue-task", task_id: taskId, streaming: "duplex" }, payload: { input: { text: "你好，这是一句用来测试音质的话，看看停顿是否自然。" } } }));
        ws.send(JSON.stringify({ header: { action: "finish-task", task_id: taskId, streaming: "duplex" }, payload: { input: {} } }));
      } else if (ev === "task-finished") { clearTimeout(timer); finish(bytes > 0 ? "OK" : "DONE_NO_AUDIO", `${frames}帧 / ${bytes}B / 首音 ${firstAudioMs}ms`); }
      else if (ev === "task-failed") { clearTimeout(timer); finish("FAILED", `${msg.header?.error_code}: ${String(msg.header?.error_message).slice(0,120)}`); }
    });
    ws.on("unexpected-response", (_q, res) => { clearTimeout(timer); finish("HTTP_ERR", `HTTP ${res.statusCode}`); });
    ws.on("error", (e) => { clearTimeout(timer); finish("WS_ERR", String(e?.message || e).slice(0, 140)); });
  });
}

console.log(`\n=== CosyVoice 流式格式 spike（key ${describeKeyStatus(KEY)}）===\n`);
for (const f of ["mp3", "pcm"]) {
  const r = await synth(f);
  const icon = r.verdict === "OK" ? "✅" : "❌";
  console.log(`${icon} format="${r.format}" → ${r.verdict}  (${r.detail})`);
}
console.log("");
