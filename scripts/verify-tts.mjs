/**
 * P5-T2: Find the correct voice for cosyvoice-v3-plus.
 *
 * The spike (commit 8fcaf206) proved the endpoint + auth + model are correct.
 * The ONLY failure was error 418 = invalid voice: longyuan_v3 / longxiaochun_v2
 * are v1/v2 tier voices — incompatible with cosyvoice-v3-plus.
 *
 * Official DashScope docs confirm cosyvoice-v3-plus requires v3-series voices.
 * This script tries the combinations in the order specified by P5-T2:
 *   1. cosyvoice-v3-plus + longanyang
 *   2. cosyvoice-v3-plus + longanhuan_v3
 *   3. cosyvoice-v3-plus + longanhuan
 *   4. cosyvoice-v3   + longanyang  (fallback model)
 *   5. cosyvoice-v3   + longanhuan_v3
 *
 * Run: node scripts/verify-tts.mjs
 * Reads keys from .env.local.
 */
import { readFileSync } from "node:fs";
// F-07:签名音频 URL / key 字节禁止入日志,统一走脱敏工具
import { redactUrl, describeKeyStatus } from "./lib/redact.mjs";

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
const TEXT = "你好，这是一段测试语音合成。";
const ENDPOINT = `${AUDIO_BASE}/api/v1/services/audio/tts/SpeechSynthesizer`;

if (!KEY) {
  console.error("ERROR: no DASHSCOPE_API_KEY found in .env.local");
  process.exit(1);
}

console.log(`\n=== P5-T2 TTS Voice Verification (key ${describeKeyStatus(KEY)}) ===`);
console.log(`endpoint: ${ENDPOINT}`);
console.log(`text: "${TEXT}"\n`);

/** Try the sync REST endpoint with the given model+voice. Returns { ok, audioUrl?, responseShape } */
async function trySyncTts(model, voice) {
  const body = {
    model,
    input: { text: TEXT, voice, format: "mp3", sample_rate: 24000 },
  };
  console.log(`\n[TRY] model=${model}  voice=${voice}`);
  let r, txt;
  try {
    r = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    });
    txt = await r.text();
  } catch (e) {
    console.log(`  NETWORK ERROR: ${e.message}`);
    return { ok: false, msg: `network: ${e.message}` };
  }

  // F-07:成功响应体里就有带签名的 audio url,只在失败时回显原始报文(错误报文无签名 URL)
  console.log(r.ok ? `  HTTP ${r.status}` : `  HTTP ${r.status}: ${txt.slice(0, 400)}`);

  if (!r.ok) {
    return { ok: false, msg: `HTTP ${r.status}: ${txt.slice(0, 300)}` };
  }

  let j;
  try {
    j = JSON.parse(txt);
  } catch {
    return { ok: false, msg: `parse error: ${txt.slice(0, 200)}` };
  }

  // Inspect the success response shape
  const audioUrl = j.output?.audio?.url;
  const audioData = j.output?.audio?.data;
  const outputKeys = JSON.stringify(Object.keys(j.output ?? {}));
  const audioKeys = JSON.stringify(Object.keys(j.output?.audio ?? {}));
  console.log(`  output keys: ${outputKeys}`);
  console.log(`  output.audio keys: ${audioKeys}`);

  if (audioUrl) {
    console.log(`  SHAPE: output.audio.url (hosted URL)`);
    // F-07:签名 URL 等同 bearer capability,脱敏后输出
    console.log(`  audio_url=${redactUrl(audioUrl)}`);
    return { ok: true, audioUrl, responseShape: "url" };
  }
  if (audioData) {
    const previewLen = Math.min(audioData.length, 40);
    console.log(`  SHAPE: output.audio.data (base64 bytes, length=${audioData.length})`);
    console.log(`  data preview: ${audioData.slice(0, previewLen)}…`);
    return { ok: true, audioData, responseShape: "base64" };
  }

  // 200 but no audio extracted
  return { ok: false, msg: `HTTP 200 but no audio url/data — full: ${txt.slice(0, 400)}` };
}

// ── Run combos in order ────────────────────────────────────────────────────────
const COMBOS = [
  { model: "cosyvoice-v3-plus", voice: "longanyang" },
  { model: "cosyvoice-v3-plus", voice: "longanhuan_v3" },
  { model: "cosyvoice-v3-plus", voice: "longanhuan" },
  { model: "cosyvoice-v3",      voice: "longanyang" },
  { model: "cosyvoice-v3",      voice: "longanhuan_v3" },
];

let winner = null;
for (const combo of COMBOS) {
  const result = await trySyncTts(combo.model, combo.voice);
  if (result.ok) {
    winner = { ...combo, ...result };
    console.log(`\n  *** SUCCESS: model=${combo.model} voice=${combo.voice} ***`);
    break;
  }
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log("\n\n=== P5-T2 VERIFICATION RESULT ===");
if (winner) {
  console.log(`STATUS: SUCCESS`);
  console.log(`  model:          ${winner.model}`);
  console.log(`  voice:          ${winner.voice}`);
  console.log(`  response shape: ${winner.responseShape}`);
  if (winner.responseShape === "url") {
    // F-07:签名 URL 脱敏输出——验证只需要"确实拿到了托管 URL",不需要 URL 本体
    console.log(`  audio_url:      ${redactUrl(winner.audioUrl)}`);
  } else {
    console.log(`  audio_data:     base64 length=${winner.audioData?.length ?? 0}`);
  }
  console.log(`\nRECOMMENDED FIX in bailian.ts:`);
  console.log(`  BAILIAN_PODCAST_TTS_VOICE = "${winner.voice}"`);
  if (winner.model !== "cosyvoice-v3-plus") {
    console.log(`  BAILIAN_PODCAST_TTS_MODEL = "${winner.model}"`);
  }
  if (winner.responseShape === "base64") {
    console.log(`  Also: adapt synthesize() to handle output.audio.data (base64) since no url was returned.`);
  } else {
    console.log(`  Parsing unchanged: output.audio.url is correct.`);
  }
} else {
  console.log(`STATUS: ALL_FAILED — see per-attempt errors above.`);
  console.log(`RECOMMENDED: honest-disable with comment that v3-series voices need SDK/WebSocket.`);
}
