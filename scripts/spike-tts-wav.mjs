// Capture real CosyVoice streaming PCM and write it to a WAV so a human can LISTEN
// and bisect TTS quality: if the WAV sounds good, the problem is browser playback
// (cascadedTtsSink scheduling); if it sounds bad, it's the source/voice/format.
// Run: node scripts/spike-tts-wav.mjs  → writes /tmp/cascade-tts-test.wav
import { readFileSync, writeFileSync } from "node:fs";
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
const URL_WS = "wss://dashscope.aliyuncs.com/api-ws/v1/inference";
const SAMPLE_RATE = 24000;
const VOICE = process.argv[2] || "longanyang";
const TEXT = "你好，我们上次聊到团队授权和亲自下场之间的拉扯，这次想接着往下问，你最近有没有遇到具体的场景？";

function wavHeader(dataLen) {
  const b = Buffer.alloc(44);
  b.write("RIFF", 0); b.writeUInt32LE(36 + dataLen, 4); b.write("WAVE", 8);
  b.write("fmt ", 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); // PCM
  b.writeUInt16LE(1, 22); // mono
  b.writeUInt32LE(SAMPLE_RATE, 24); b.writeUInt32LE(SAMPLE_RATE * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write("data", 36); b.writeUInt32LE(dataLen, 40);
  return b;
}

const chunks = [];
await new Promise((resolve) => {
  const ws = new WebSocket(URL_WS, { headers: { Authorization: `Bearer ${KEY}` } });
  const taskId = "wav-spike-task-0001";
  let done = false;
  const finish = () => { if (done) return; done = true; try { ws.close(); } catch {} resolve(); };
  const timer = setTimeout(finish, 30000);
  ws.on("open", () => {
    ws.send(JSON.stringify({
      header: { action: "run-task", task_id: taskId, streaming: "duplex" },
      payload: { task_group: "audio", task: "tts", function: "SpeechSynthesizer", model: "cosyvoice-v3-plus",
        parameters: { text_type: "PlainText", voice: VOICE, format: "pcm", sample_rate: SAMPLE_RATE }, input: {} }
    }));
  });
  ws.on("message", (data, isBinary) => {
    if (isBinary || (Buffer.isBuffer(data) && data[0] !== 0x7b)) { chunks.push(Buffer.from(data)); return; }
    let msg = {}; try { msg = JSON.parse(data.toString()); } catch { return; }
    const ev = msg.header?.event;
    if (ev === "task-started") {
      ws.send(JSON.stringify({ header: { action: "continue-task", task_id: taskId, streaming: "duplex" }, payload: { input: { text: TEXT } } }));
      ws.send(JSON.stringify({ header: { action: "finish-task", task_id: taskId, streaming: "duplex" }, payload: { input: {} } }));
    } else if (ev === "task-finished" || ev === "task-failed") { clearTimeout(timer); finish(); }
  });
  ws.on("error", () => { clearTimeout(timer); finish(); });
});

const pcm = Buffer.concat(chunks);
const out = "/tmp/cascade-tts-test.wav";
writeFileSync(out, Buffer.concat([wavHeader(pcm.length), pcm]));

// Stats to sanity-check the format (correct s16le 24k mono should look reasonable).
const n = Math.floor(pcm.length / 2);
let sumSq = 0, peak = 0;
for (let i = 0; i < n; i++) { const s = pcm.readInt16LE(i * 2); sumSq += s * s; peak = Math.max(peak, Math.abs(s)); }
const rms = Math.sqrt(sumSq / Math.max(1, n));
console.log(`\n=== CosyVoice PCM → WAV（voice=${VOICE}）===`);
console.log(`字节: ${pcm.length}  采样: ${n}  时长: ${(n / SAMPLE_RATE).toFixed(2)}s`);
console.log(`RMS: ${rms.toFixed(0)} (健康约 1000~8000)  峰值: ${peak} (满刻度 32767，接近=削顶)`);
console.log(`写入: ${out}`);
console.log(`\n👉 用系统播放器打开听：afplay ${out}`);
console.log(`   听感好 → 问题在浏览器播放层(cascadedTtsSink)；听感差/机械/破音 → 源/音色/格式问题。\n`);
