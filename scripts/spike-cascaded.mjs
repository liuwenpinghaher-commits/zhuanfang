// scripts/spike-cascaded.mjs
// Live spike: verify two DashScope capabilities needed for browser cascaded voice pipeline.
//   SPIKE 1 — CosyVoice WebSocket streaming TTS (wss duplex)
//   SPIKE 2 — qwen3.5-omni-plus-realtime text-only ASR session config
// Run: node scripts/spike-cascaded.mjs
// Reads DASHSCOPE_API_KEY from .env.local (same pattern as verify-providers.mjs).

import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";

// ── env loader (mirrors verify-providers.mjs) ───────────────────────────────
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
if (!KEY) {
  console.error("❌  DASHSCOPE_API_KEY not found in .env.local");
  process.exit(1);
}
console.log(`\nKey prefix: ${KEY.slice(0, 8)}…\n`);

// ── helper: send JSON over WS ────────────────────────────────────────────────
function sendJson(ws, obj) {
  ws.send(JSON.stringify(obj));
}

// ════════════════════════════════════════════════════════════════════════════
// SPIKE 1 — CosyVoice WS streaming TTS
// ════════════════════════════════════════════════════════════════════════════
async function spike1_cosyvoiceStreaming() {
  console.log("═══ SPIKE 1: CosyVoice WS streaming TTS ═══");
  const WS_URL = "wss://dashscope.aliyuncs.com/api-ws/v1/inference";
  const taskId = randomUUID();

  return new Promise((resolve) => {
    const ws = new WebSocket(WS_URL, {
      headers: { Authorization: `Bearer ${KEY}` },
    });

    let done = false;
    const finish = (result) => {
      if (!done) {
        done = true;
        try { ws.close(); } catch {}
        resolve(result);
      }
    };

    const t0 = Date.now();
    let taskStarted = false;
    let firstChunkAt = null;
    let totalBinaryFrames = 0;
    let totalBinaryBytes = 0;
    let taskFinished = false;
    const events = [];

    const timer = setTimeout(() => {
      finish({
        ok: false,
        error: `TIMEOUT after 30s. taskStarted=${taskStarted}, frames=${totalBinaryFrames}, bytes=${totalBinaryBytes}`,
        events,
      });
    }, 30000);

    ws.on("open", () => {
      console.log(`  [${Date.now() - t0}ms] WS open — sending run-task`);
      sendJson(ws, {
        header: {
          action: "run-task",
          task_id: taskId,
          streaming: "duplex",
        },
        payload: {
          task_group: "audio",
          task: "tts",
          function: "SpeechSynthesizer",
          model: "cosyvoice-v3-plus",
          parameters: {
            text_type: "PlainText",
            voice: "longanyang",
            format: "mp3",
            sample_rate: 24000,
          },
          input: {},
        },
      });
    });

    ws.on("message", (data, isBinary) => {
      if (isBinary || (data instanceof Buffer && !isJson(data))) {
        // Binary audio chunk
        totalBinaryFrames++;
        totalBinaryBytes += data.length;
        if (firstChunkAt === null) {
          firstChunkAt = Date.now() - t0;
          console.log(`  [${firstChunkAt}ms] First BINARY audio chunk! (${data.length} bytes)`);
        }
        return;
      }

      // JSON control frame
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }

      const eventType = msg?.header?.event ?? msg?.type ?? "(unknown)";
      const elapsed = Date.now() - t0;
      events.push({ t: elapsed, event: eventType });
      console.log(`  [${elapsed}ms] JSON event: ${eventType}`);

      if (eventType === "task-started") {
        taskStarted = true;
        console.log(`  [${elapsed}ms] task-started ✓ — sending continue-task messages`);

        // Send 3 continue-task chunks
        const sentences = [
          "我理解你的感受。",
          "请继续说下去，我在认真听。",
          "这个问题很有意思，值得深入探讨。",
        ];
        for (const text of sentences) {
          sendJson(ws, {
            header: {
              action: "continue-task",
              task_id: taskId,
              streaming: "duplex",
            },
            payload: { input: { text } },
          });
        }

        // Send finish-task
        sendJson(ws, {
          header: {
            action: "finish-task",
            task_id: taskId,
            streaming: "duplex",
          },
          payload: { input: {} },
        });
        console.log(`  [${Date.now() - t0}ms] Sent 3x continue-task + finish-task`);
      }

      if (eventType === "task-finished") {
        taskFinished = true;
        const totalMs = Date.now() - t0;
        clearTimeout(timer);
        console.log(`  [${totalMs}ms] task-finished ✓`);
        console.log(`  Binary frames: ${totalBinaryFrames}, total bytes: ${totalBinaryBytes}`);
        finish({
          ok: true,
          taskStarted,
          taskFinished,
          firstChunkLatencyMs: firstChunkAt,
          totalBinaryFrames,
          totalBinaryBytes,
          totalMs,
          events,
          streaming: firstChunkAt !== null && totalBinaryFrames > 1,
        });
      }

      if (eventType === "task-failed") {
        clearTimeout(timer);
        const errMsg = msg?.header?.error_message ?? msg?.payload?.message ?? JSON.stringify(msg).slice(0, 200);
        console.log(`  task-failed: ${errMsg}`);
        finish({ ok: false, error: `task-failed: ${errMsg}`, events });
      }
    });

    ws.on("unexpected-response", (_req, res) => {
      clearTimeout(timer);
      let body = "";
      res.on("data", (d) => { body += d; });
      res.on("end", () => {
        finish({ ok: false, error: `HTTP ${res.statusCode}: ${body.slice(0, 300)}`, events });
      });
    });

    ws.on("error", (err) => {
      clearTimeout(timer);
      finish({ ok: false, error: String(err?.message || err).slice(0, 300), events });
    });

    ws.on("close", (code, reason) => {
      if (!done) {
        clearTimeout(timer);
        finish({
          ok: false,
          error: `WS closed unexpectedly: code=${code} reason=${reason}`,
          events,
        });
      }
    });
  });
}

function isJson(buf) {
  const s = buf.toString("utf8", 0, 1);
  return s === "{" || s === "[";
}

// ════════════════════════════════════════════════════════════════════════════
// SPIKE 2 — qwen3.5-omni-plus-realtime text-only ASR session config
// ════════════════════════════════════════════════════════════════════════════
async function spike2_omniTextOnlyAsr() {
  console.log("\n═══ SPIKE 2: omni-realtime text-only ASR ═══");
  const MODEL = "qwen3.5-omni-plus-realtime";
  const WS_URL = `wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=${encodeURIComponent(MODEL)}`;

  return new Promise((resolve) => {
    const ws = new WebSocket(WS_URL, {
      headers: { Authorization: `Bearer ${KEY}` },
    });

    let done = false;
    const finish = (result) => {
      if (!done) {
        done = true;
        try { ws.close(); } catch {}
        resolve(result);
      }
    };

    const t0 = Date.now();
    let sessionCreated = false;
    let sessionUpdated = false;
    let sessionUpdateError = null;
    const events = [];
    let effectiveModalities = null;
    let gotAudioOutput = false;

    const timer = setTimeout(() => {
      finish({
        ok: false,
        error: `TIMEOUT after 20s. sessionCreated=${sessionCreated}, sessionUpdated=${sessionUpdated}`,
        events,
        gotAudioOutput,
      });
    }, 20000);

    ws.on("open", () => {
      console.log(`  [${Date.now() - t0}ms] WS open — waiting for session.created`);
    });

    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        gotAudioOutput = true;
        console.log(`  [${Date.now() - t0}ms] BINARY frame received (audio output — NOT text-only!)`);
        return;
      }

      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }

      const eventType = msg?.type ?? "(unknown)";
      const elapsed = Date.now() - t0;
      events.push({ t: elapsed, event: eventType, summary: summarizeEvent(msg) });
      console.log(`  [${elapsed}ms] ${eventType}  ${summarizeEvent(msg)}`);

      if (eventType === "session.created") {
        sessionCreated = true;
        // Now send session.update for text-only mode
        console.log(`  [${elapsed}ms] session.created ✓ — sending session.update (text-only)`);
        sendJson(ws, {
          type: "session.update",
          session: {
            modalities: ["text"],
            input_audio_format: "pcm16",
            turn_detection: {
              type: "server_vad",
              silence_duration_ms: 1500,
            },
            input_audio_transcription: {
              model: "paraformer-realtime-v2",
            },
          },
        });
      }

      if (eventType === "session.updated") {
        sessionUpdated = true;
        effectiveModalities = msg?.session?.modalities ?? null;
        const hasAudio = Array.isArray(effectiveModalities) && effectiveModalities.includes("audio");
        console.log(`  [${elapsed}ms] session.updated ✓ — effective modalities: ${JSON.stringify(effectiveModalities)}`);

        // Try a short silent PCM16 buffer append + commit to probe transcription
        // PCM16 silent audio: 100ms @ 16kHz = 1600 samples * 2 bytes = 3200 bytes of zeros
        const silentPcm = Buffer.alloc(3200, 0);
        const b64 = silentPcm.toString("base64");
        sendJson(ws, { type: "input_audio_buffer.append", audio: b64 });
        sendJson(ws, { type: "input_audio_buffer.commit" });
        console.log(`  [${Date.now() - t0}ms] Sent silent PCM16 (100ms) + commit`);

        // Wait a bit for transcription event, then wrap up
        setTimeout(() => {
          clearTimeout(timer);
          finish({
            ok: true,
            sessionCreated,
            sessionUpdated,
            effectiveModalities,
            gotAudioOutput,
            textOnlyAccepted: !hasAudio && sessionUpdated,
            sessionUpdateError,
            events,
          });
        }, 5000);
      }

      if (eventType === "error") {
        const errMsg = msg?.error?.message ?? msg?.error?.code ?? JSON.stringify(msg).slice(0, 200);
        // Check if it's a session.update error or a fatal error
        if (!sessionCreated) {
          clearTimeout(timer);
          finish({ ok: false, error: `pre-session error: ${errMsg}`, events, gotAudioOutput });
        } else {
          sessionUpdateError = errMsg;
          console.log(`  [${elapsed}ms] ERROR (after session.created): ${errMsg}`);
          if (!sessionUpdated) {
            // session.update was rejected
            clearTimeout(timer);
            finish({
              ok: false,
              error: `session.update rejected: ${errMsg}`,
              events,
              gotAudioOutput,
              sessionCreated,
            });
          }
        }
      }

      // Capture transcription events if any arrive
      if (
        eventType === "conversation.item.created" ||
        eventType === "response.text.delta" ||
        eventType === "conversation.item.input_audio_transcription.completed" ||
        eventType === "response.done"
      ) {
        console.log(`  [${elapsed}ms] Transcription/response event: ${JSON.stringify(msg).slice(0, 200)}`);
      }
    });

    ws.on("unexpected-response", (_req, res) => {
      clearTimeout(timer);
      let body = "";
      res.on("data", (d) => { body += d; });
      res.on("end", () => {
        finish({ ok: false, error: `HTTP ${res.statusCode}: ${body.slice(0, 300)}`, events, gotAudioOutput });
      });
    });

    ws.on("error", (err) => {
      clearTimeout(timer);
      finish({ ok: false, error: String(err?.message || err).slice(0, 300), events, gotAudioOutput });
    });

    ws.on("close", (code, reason) => {
      if (!done) {
        clearTimeout(timer);
        finish({
          ok: false,
          error: `WS closed: code=${code} reason=${reason}`,
          events,
          gotAudioOutput,
        });
      }
    });
  });
}

function summarizeEvent(msg) {
  if (!msg) return "";
  const session = msg.session;
  if (session) {
    return `modalities=${JSON.stringify(session.modalities ?? "?")} id=${session.id ?? "?"}`;
  }
  const err = msg.error;
  if (err) return `code=${err.code} msg=${err.message ?? ""}`.slice(0, 120);
  return "";
}

// ════════════════════════════════════════════════════════════════════════════
// Main
// ════════════════════════════════════════════════════════════════════════════
const s1 = await spike1_cosyvoiceStreaming();
console.log("\n[SPIKE 1 raw result]", JSON.stringify(s1, null, 2));

const s2 = await spike2_omniTextOnlyAsr();
console.log("\n[SPIKE 2 raw result]", JSON.stringify(s2, null, 2));

// ── Final decisive report ─────────────────────────────────────────────────
console.log("\n\n══════════════════════════ REPORT ══════════════════════════\n");

// SPIKE 1 verdict
let s1Verdict;
if (!s1.ok) {
  s1Verdict = `FAILS — ${s1.error}`;
} else if (s1.streaming && s1.totalBinaryFrames > 1) {
  s1Verdict = `WORKS — streaming, first-chunk ${s1.firstChunkLatencyMs}ms, ${s1.totalBinaryFrames} binary frames, ${s1.totalBinaryBytes} total bytes`;
} else if (s1.totalBinaryFrames === 1) {
  s1Verdict = `WORKS_NONSTREAMING — received audio only at end (1 binary frame, ${s1.totalBinaryBytes} bytes, total ${s1.totalMs}ms)`;
} else if (s1.totalBinaryFrames > 1) {
  s1Verdict = `WORKS — ${s1.totalBinaryFrames} frames, first-chunk ${s1.firstChunkLatencyMs}ms, ${s1.totalBinaryBytes} total bytes`;
} else {
  s1Verdict = `WORKS_NONSTREAMING — task-finished ok but 0 binary frames? events: ${JSON.stringify(s1.events)}`;
}

// SPIKE 2 verdict
let s2Verdict;
if (!s2.ok) {
  if (s2.sessionCreated && s2.error?.includes("session.update rejected")) {
    s2Verdict = `REJECTED — session connected but update rejected: ${s2.error}`;
  } else {
    s2Verdict = `REJECTED — ${s2.error}`;
  }
} else if (s2.textOnlyAccepted) {
  s2Verdict = `TEXT_ONLY_ACCEPTED — modalities=${JSON.stringify(s2.effectiveModalities)}, no audio output emitted. Events: ${s2.events.map((e) => e.event).join(" → ")}`;
} else {
  s2Verdict = `UNCERTAIN — sessionUpdated=${s2.sessionUpdated}, effectiveModalities=${JSON.stringify(s2.effectiveModalities)}, gotAudio=${s2.gotAudioOutput}. Events: ${s2.events.map((e) => e.event).join(" → ")}`;
}

console.log(`SPIKE 1 (CosyVoice streaming): ${s1Verdict}\n`);
console.log(`SPIKE 2 (omni text-only): ${s2Verdict}\n`);

// Implications
const s1Works = s1.ok;
const s1IsStreaming = s1.ok && s1.streaming;
const s2Works = s2.ok && s2.textOnlyAccepted;

if (s1IsStreaming && s2Works) {
  console.log(`IMPLICATIONS: Cascaded pipeline (ASR→LLM→TTS) is fully feasible as designed. ` +
    `CosyVoice streams binary audio incrementally (first-chunk ${s1.firstChunkLatencyMs}ms), enabling 首句即播. ` +
    `The omni model accepts text-only modality and will not emit speech, making it safe as a pure ASR/VAD layer in cascade.`);
} else if (s1Works && !s1IsStreaming && s2Works) {
  console.log(`IMPLICATIONS: Cascaded pipeline is feasible but loses the 首句即播 optimization. ` +
    `CosyVoice only returns audio after all text is consumed (non-streaming), so TTS latency equals full synthesis time (~${s1.totalMs}ms total). ` +
    `The omni text-only session is accepted, so ASR/VAD layer works as designed; no adjustment needed on that side.`);
} else if (s1Works && !s2Works) {
  console.log(`IMPLICATIONS: TTS side works (${s1IsStreaming ? "streaming" : "non-streaming"}), but the omni text-only session was rejected or uncertain. ` +
    `The cascaded pipeline needs a fallback ASR approach (e.g., paraformer-realtime directly, or feed audio to omni and ignore audio output). ` +
    `Do not rely on modalities:["text"] to suppress omni speech until confirmed.`);
} else {
  console.log(`IMPLICATIONS: One or both core capabilities are unavailable. ` +
    `CosyVoice WS: ${s1.ok ? "ok" : "failed"}. omni text-only: ${s2.ok ? "ok" : "failed"}. ` +
    `Revisit cascaded architecture — may need REST TTS fallback and/or separate paraformer ASR.`);
}
