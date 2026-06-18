// E2E: hit the RUNNING TTS proxy WS with various voices, confirm audio vs 418.
// Run: node scripts/spike-tts-proxy-voice.mjs   (service must be up on :8787)
// Proves the cascade TTS path (browser → proxy → CosyVoice) including voice normalization.
import WebSocket from "ws";

const BASE = "http://127.0.0.1:8787";
const WS_BASE = "ws://127.0.0.1:8787";

async function newSession() {
  const res = await fetch(`${BASE}/api/realtime-voice/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({})
  });
  const j = await res.json();
  return j.sessionId;
}

function speak(sessionId, voice) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${WS_BASE}/api/realtime-voice/ws/tts/${sessionId}`);
    let bytes = 0, frames = 0, done = false;
    const finish = (verdict, detail) => {
      if (done) return;
      done = true;
      try { ws.close(); } catch {}
      resolve({ voice, verdict, detail, bytes, frames });
    };
    const timer = setTimeout(() => finish(bytes > 0 ? "PARTIAL" : "TIMEOUT", `${frames} 音频帧 / ${bytes}B`), 20000);
    ws.on("open", () => ws.send(JSON.stringify({ type: "speak", segments: ["你好，这是一句级联语音的测试。"], voice })));
    ws.on("message", (data, isBinary) => {
      if (isBinary || Buffer.isBuffer(data) && data[0] !== 0x7b /* not '{' */) {
        bytes += data.length; frames++;
        return;
      }
      let msg = {};
      try { msg = JSON.parse(data.toString()); } catch { bytes += data.length; frames++; return; }
      if (msg.type === "tts.done") { clearTimeout(timer); finish(bytes > 0 ? "OK" : "DONE_NO_AUDIO", `${frames} 帧 / ${bytes}B`); }
      else if (msg.type === "error") { clearTimeout(timer); finish("ERROR", String(msg.message).slice(0, 160)); }
    });
    ws.on("unexpected-response", (_q, res) => { clearTimeout(timer); finish("HTTP_ERR", `HTTP ${res.statusCode}`); });
    ws.on("error", (e) => { clearTimeout(timer); finish("WS_ERR", String(e?.message || e).slice(0, 160)); });
  });
}

const sessionId = await newSession();
console.log(`\n=== TTS 代理 voice spike（session ${sessionId}）===\n`);
for (const v of ["longanyang", "longanhuan", "longanli", "longanlang", "longanwen", "longanya"]) {
  const r = await speak(sessionId, v);
  const icon = r.verdict === "OK" ? "✅" : r.verdict === "ERROR" || r.verdict.includes("ERR") ? "❌" : "⚠️";
  console.log(`${icon} voice="${r.voice}" → ${r.verdict}  (${r.detail})`);
}
console.log("");
