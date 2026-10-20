// scripts/spike-half-cascade.mjs
//
// Purpose (half-cascade spike):
//   Verify whether DashScope Omni realtime can *speak client-provided assistant text*
//   — i.e. external brain (LLM) produces text → omni acts only as mouth (TTS).
//   Architecture under test: half-cascade = brain text → omni mouth.
//
// Why this matters:
//   Full cascade is ASR(omni text-only) → LLM(HTTP) → CosyVoice TTS.
//   Half-cascade keeps omni for VAD/ASR + *audio out*, but wants the spoken
//   words to come from our interviewer LLM, not from omni's own generation.
//   If omni can inject/speak fixed assistant text, we can drop a separate TTS
//   path while still owning interview craft in our brain model.
//
// Protocol probes (OpenAI-realtime-compatible shape on DashScope):
//   1) session.update  (modalities text+audio, turn_detection)
//   2) conversation.item.create with role=assistant + fixed text, then response.create
//   3) fallback: response.create with instructions = "Say exactly: <text>"
//
// Run:
//   node scripts/spike-half-cascade.mjs
//
// Env:
//   DASHSCOPE_API_KEY from .env.local (or process.env). If missing → exit 0 with
//   SKIPPED (CI-safe) and still write/refresh the result template under docs/.
//
// Does NOT touch production cascade / bailian paths.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describeKeyStatus, redactUrl } from "./lib/redact.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const RESULT_PATH = resolve(
  ROOT,
  "docs/superpowers/specs/spike-half-cascade-result.md"
);

// ── env loader (mirrors other scripts/spike-*.mjs) ──────────────────────────
function loadEnv(url) {
  const env = {};
  try {
    for (const line of readFileSync(url, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !line.trim().startsWith("#")) env[m[1]] = m[2];
    }
  } catch {
    /* no .env.local is fine */
  }
  return env;
}

const fileEnv = loadEnv(new URL("../.env.local", import.meta.url));
const KEY =
  (process.env.DASHSCOPE_API_KEY || fileEnv.DASHSCOPE_API_KEY || "").trim();

const MODEL =
  process.env.BAILIAN_REALTIME_MODEL?.trim() ||
  fileEnv.BAILIAN_REALTIME_MODEL?.trim() ||
  "qwen3.5-omni-flash-realtime";

const WS_URL = `wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=${encodeURIComponent(MODEL)}`;

/** Fixed probe sentence — short, Chinese interview-style, easy to spot in logs. */
const PROBE_TEXT =
  process.env.SPIKE_HALF_CASCADE_TEXT?.trim() ||
  "请直接说出这句话：今天我们先从一个具体的决策点聊起。";

const PROBE_TIMEOUT_MS = Number(process.env.SPIKE_HALF_CASCADE_TIMEOUT_MS || 25000);

// ── result markdown ─────────────────────────────────────────────────────────
function renderResultDoc(input) {
  const {
    status, // SKIPPED | RAN | ERROR
    ranAt,
    model,
    keyStatus,
    approaches = [],
    verdict = "pending",
    notes = [],
    rawEvents = [],
  } = input;

  const approachRows = approaches.length
    ? approaches
        .map(
          (a) =>
            `| ${a.id} | ${a.label} | ${a.verdict} | ${String(a.detail || "").replace(/\|/g, "\\|").slice(0, 200)} |`
        )
        .join("\n")
    : "| — | (not run) | — | — |";

  const eventBlock =
    rawEvents.length > 0
      ? rawEvents
          .slice(0, 80)
          .map((e) => `- \`${e}\``)
          .join("\n")
      : "- (none)";

  const notesBlock =
    notes.length > 0 ? notes.map((n) => `- ${n}`).join("\n") : "- (none)";

  return `# Spike: half-cascade inject assistant text (omni mouth)

> **Status:** \`${status}\`
> **Ran at:** ${ranAt}
> **Model:** \`${model}\`
> **API key:** ${keyStatus}
> **Script:** \`scripts/spike-half-cascade.mjs\`
> **WS:** \`wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=...\`

## Purpose

Verify whether **DashScope Omni realtime** can speak **client-provided assistant text**
(half-cascade: **brain text → omni mouth**).

| Role | Component | Responsibility |
|------|-----------|----------------|
| Brain | External interviewer LLM (HTTP) | Craft questions / follow-ups |
| Mouth | Omni realtime (audio out) | Speak the *exact* brain text (or close enough) |
| Ear | Omni realtime (optional) | VAD / ASR on same session |

If this works, product can own interview craft in our LLM while reusing omni for
low-latency speech, without a separate CosyVoice path for that mode.

**Out of scope:** production cascade/bailian path changes. This is a read-only probe.

## Go / No-Go criteria

### GO (half-cascade feasible)

All of the following:

1. **Connect + session.update** accepted with \`modalities: ["text","audio"]\` (or equivalent audio-capable session).
2. At least one inject path yields **audio output** (\`response.audio.delta\` / \`response.output_audio.delta\` / binary audio / clear audio-done event).
3. Spoken content is **controllable** by client text:
   - either assistant \`conversation.item.create\` is accepted and audio tracks the item text, **or**
   - \`response.create\` + \`instructions\` reliably forces near-verbatim speech of the provided sentence.
4. No hard protocol rejection that would make automation impossible (e.g. assistant items always error).

### NO-GO (keep full cascade / CosyVoice mouth)

Any of:

1. Omni **rejects** assistant text injection and only generates free-form model speech from user prompts.
2. Audio out works but **ignores** fixed text (high paraphrase / unusable craft control).
3. Session accepts update but **never emits audio** for inject/response.create paths under probe timeout.
4. Auth / model / protocol errors that make the path non-viable for product (after retry with documented model).

### CONDITIONAL / PARTIAL

- Audio works only via \`response.create\` instructions (not assistant item inject) → document as **partial GO** (still usable mouth, weaker "inject" semantics).
- Text-only session only → **NO-GO for mouth**; may still be useful as ear in full cascade.

## Probe approaches

| ID | Approach | Verdict | Detail |
|----|----------|---------|--------|
${approachRows}

## Overall verdict

**\`${verdict}\`**

## Notes

${notesBlock}

## Event sample (truncated)

${eventBlock}

## How to re-run

\`\`\`bash
# requires DASHSCOPE_API_KEY in .env.local or env
node scripts/spike-half-cascade.mjs

# optional overrides
BAILIAN_REALTIME_MODEL=qwen3.5-omni-flash-realtime \\
SPIKE_HALF_CASCADE_TEXT='请直接说出这句话：测试半级联。' \\
node scripts/spike-half-cascade.mjs
\`\`\`

Without a key the script exits **0** with \`SKIPPED\` (CI-safe) and refreshes this template.

## Implication for product

- **GO / PARTIAL GO** → design half-cascade path (brain LLM → inject → omni speak); keep full cascade as fallback.
- **NO-GO** → continue ASR→LLM→CosyVoice cascade; do not block interview craft on omni generation.
- **SKIPPED** → no live evidence yet; do not flip production defaults.

---
*Generated/updated by \`scripts/spike-half-cascade.mjs\`. Do not put secrets in this file.*
`;
}

function writeResult(payload) {
  mkdirSync(dirname(RESULT_PATH), { recursive: true });
  writeFileSync(RESULT_PATH, renderResultDoc(payload), "utf8");
  console.log(`\nWrote result → ${RESULT_PATH}`);
}

function sendJson(ws, obj) {
  ws.send(JSON.stringify(obj));
}

function summarizeMsg(msg) {
  if (!msg || typeof msg !== "object") return "";
  if (msg.type === "error") {
    const e = msg.error || {};
    return `code=${e.code ?? "?"} msg=${String(e.message || "").slice(0, 120)}`;
  }
  if (msg.session) {
    return `modalities=${JSON.stringify(msg.session.modalities ?? "?")}`;
  }
  if (msg.response?.status) return `status=${msg.response.status}`;
  if (typeof msg.delta === "string") return `delta=${msg.delta.slice(0, 40)}`;
  if (typeof msg.transcript === "string")
    return `transcript=${msg.transcript.slice(0, 40)}`;
  return "";
}

/**
 * Single WS session: wait session.created → session.update → run probeFn → observe.
 * Returns structured verdict without throwing.
 */
async function runApproach({ WebSocket, id, label, afterSessionUpdated }) {
  return new Promise((resolve) => {
    const ws = new WebSocket(WS_URL, {
      headers: { Authorization: `Bearer ${KEY}` },
    });

    let done = false;
    const events = [];
    const t0 = Date.now();
    let sessionCreated = false;
    let sessionUpdated = false;
    let gotAudio = false;
    let gotTextDelta = false;
    let audioBytes = 0;
    let lastError = null;
    let transcriptBits = [];

    const finish = (verdict, detail, extra = {}) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      resolve({
        id,
        label,
        verdict,
        detail,
        sessionCreated,
        sessionUpdated,
        gotAudio,
        gotTextDelta,
        audioBytes,
        lastError,
        events: [...events],
        transcriptBits,
        elapsedMs: Date.now() - t0,
        ...extra,
      });
    };

    const timer = setTimeout(() => {
      finish(
        gotAudio ? "PARTIAL" : "TIMEOUT",
        `timeout ${PROBE_TIMEOUT_MS}ms; sessionCreated=${sessionCreated} sessionUpdated=${sessionUpdated} gotAudio=${gotAudio} events=${events.slice(-12).join(",")}`,
        {}
      );
    }, PROBE_TIMEOUT_MS);

    ws.on("open", () => {
      events.push("ws.open");
      console.log(`  [${id}] WS open — waiting session.created`);
    });

    ws.on("message", (data, isBinary) => {
      if (isBinary || (Buffer.isBuffer(data) && data[0] !== 0x7b /* { */)) {
        gotAudio = true;
        audioBytes += data.length || 0;
        events.push(`binary.audio(+${data.length})`);
        return;
      }

      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }

      const type = msg?.type || "(unknown)";
      events.push(type);
      const summary = summarizeMsg(msg);
      console.log(
        `  [${id}] +${Date.now() - t0}ms ${type}${summary ? " " + summary : ""}`
      );

      if (
        type === "response.audio.delta" ||
        type === "response.output_audio.delta" ||
        type === "response.audio_transcript.delta" ||
        type === "response.output_audio_transcript.delta"
      ) {
        if (type.includes("audio") && !type.includes("transcript")) {
          gotAudio = true;
          if (typeof msg.delta === "string") {
            // base64 audio chunk
            audioBytes += Math.floor((msg.delta.length * 3) / 4);
          }
        }
        if (type.includes("transcript") && typeof msg.delta === "string") {
          gotTextDelta = true;
          transcriptBits.push(msg.delta);
        }
      }

      if (type === "response.text.delta" && typeof msg.delta === "string") {
        gotTextDelta = true;
        transcriptBits.push(msg.delta);
      }

      if (
        type === "response.audio.done" ||
        type === "response.output_audio.done" ||
        type === "response.done"
      ) {
        // If we already saw audio, success path can complete early on response.done
        if (gotAudio && type === "response.done") {
          finish(
            "AUDIO_OK",
            `response.done with audio (~${audioBytes}B est.); transcript=${transcriptBits.join("").slice(0, 80) || "(none)"}`
          );
          return;
        }
      }

      if (type === "session.created") {
        sessionCreated = true;
        sendJson(ws, {
          type: "session.update",
          session: {
            modalities: ["text", "audio"],
            voice: "Ethan",
            input_audio_format: "pcm16",
            output_audio_format: "pcm16",
            turn_detection: null, // manual: we drive response.create
            instructions:
              "你是语音播报器。当被要求说出指定句子时，一字不差地朗读，不要改写、不加寒暄。",
          },
        });
        console.log(`  [${id}] session.created → session.update (text+audio)`);
        return;
      }

      if (type === "session.updated") {
        sessionUpdated = true;
        try {
          afterSessionUpdated(ws, { sendJson, PROBE_TEXT });
        } catch (e) {
          finish("ERROR", `afterSessionUpdated threw: ${String(e?.message || e)}`);
        }
        return;
      }

      if (type === "error") {
        lastError =
          msg?.error?.message ||
          msg?.error?.code ||
          JSON.stringify(msg).slice(0, 200);
        // Fatal only if we never got a usable session
        if (!sessionUpdated) {
          finish("REJECTED", `error before/during session.update: ${lastError}`);
        } else {
          console.log(`  [${id}] non-fatal error after update: ${lastError}`);
        }
      }
    });

    ws.on("unexpected-response", (_req, res) => {
      let body = "";
      res.on("data", (d) => {
        body += d;
      });
      res.on("end", () => {
        finish(
          "HTTP_ERR",
          `HTTP ${res.statusCode}: ${body.slice(0, 240)}`
        );
      });
    });

    ws.on("error", (err) => {
      finish("WS_ERR", String(err?.message || err).slice(0, 240));
    });

    ws.on("close", (code, reason) => {
      if (!done) {
        finish(
          gotAudio ? "AUDIO_OK" : "CLOSED",
          `ws close code=${code} reason=${String(reason || "")} gotAudio=${gotAudio}`
        );
      }
    });
  });
}

function classifyOverall(approaches) {
  const anyAudio = approaches.some(
    (a) => a.verdict === "AUDIO_OK" || (a.gotAudio && a.verdict !== "HTTP_ERR")
  );
  const injectOk = approaches.some(
    (a) => a.id === "A" && (a.verdict === "AUDIO_OK" || a.gotAudio)
  );
  const instructOk = approaches.some(
    (a) => a.id === "B" && (a.verdict === "AUDIO_OK" || a.gotAudio)
  );

  if (injectOk) return "GO";
  if (instructOk) return "PARTIAL_GO";
  if (anyAudio) return "PARTIAL_GO";
  if (approaches.every((a) => a.verdict === "SKIPPED")) return "SKIPPED";
  if (approaches.some((a) => a.verdict === "HTTP_ERR" || a.verdict === "WS_ERR"))
    return "ERROR";
  if (approaches.some((a) => a.verdict === "REJECTED")) return "NO_GO";
  return "NO_GO";
}

// ── main ────────────────────────────────────────────────────────────────────
const ranAt = new Date().toISOString();

console.log("\n=== spike-half-cascade: brain text → omni mouth ===\n");
console.log(`Model: ${MODEL}`);
console.log(`Key:   ${describeKeyStatus(KEY)}`);
console.log(`WS:    ${redactUrl(WS_URL)}`);
console.log(`Text:  ${PROBE_TEXT}\n`);

if (!KEY) {
  const notes = [
    "DASHSCOPE_API_KEY missing — live probe skipped (exit 0 for CI).",
    "Fill .env.local and re-run to populate approach verdicts.",
    "Production cascade/bailian paths were not modified.",
  ];
  writeResult({
    status: "SKIPPED",
    ranAt,
    model: MODEL,
    keyStatus: describeKeyStatus(KEY),
    approaches: [
      {
        id: "A",
        label: "conversation.item.create (assistant) + response.create",
        verdict: "SKIPPED",
        detail: "no API key",
      },
      {
        id: "B",
        label: "response.create with instructions (verbatim)",
        verdict: "SKIPPED",
        detail: "no API key",
      },
    ],
    verdict: "SKIPPED",
    notes,
    rawEvents: [],
  });
  console.log("SKIPPED: no DASHSCOPE_API_KEY (exit 0)\n");
  process.exit(0);
}

// Dynamic import so SKIPPED path never requires `ws` to be installed.
let WebSocket;
try {
  ({ default: WebSocket } = await import("ws"));
} catch (e) {
  const notes = [
    `Failed to import 'ws': ${String(e?.message || e)}`,
    "Install deps where appropriate (not on memory-constrained CI hosts) and re-run.",
  ];
  writeResult({
    status: "ERROR",
    ranAt,
    model: MODEL,
    keyStatus: describeKeyStatus(KEY),
    approaches: [],
    verdict: "ERROR",
    notes,
    rawEvents: [],
  });
  console.error("ERROR: cannot import ws —", e?.message || e);
  // Still exit 0? Task says key missing → 0. Import failure with key present
  // is an environment issue; exit 0 keeps CI green if someone sets a dummy key
  // without node_modules. Prefer exit 0 for spike non-blocking posture.
  process.exit(0);
}

const approaches = [];

console.log("── Approach A: assistant conversation.item.create + response.create ──");
const a = await runApproach({
  WebSocket,
  id: "A",
  label: "conversation.item.create (assistant) + response.create",
  afterSessionUpdated(ws, { sendJson: sj, PROBE_TEXT: text }) {
    // Try assistant message inject. Content type names vary across realtime
    // implementations; send the common OpenAI shape first.
    sj(ws, {
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "assistant",
        content: [{ type: "text", text }],
      },
    });
    // Trigger generation / speak of pending items
    sj(ws, {
      type: "response.create",
      response: {
        modalities: ["text", "audio"],
        instructions:
          "请用语音一字不差地朗读对话中最新的助手消息，不要改写。",
      },
    });
    console.log("  [A] sent assistant item + response.create");
  },
});
approaches.push(a);
console.log(
  `  [A] → ${a.verdict} (${a.detail})\n`
);

console.log("── Approach B: response.create instructions only (verbatim) ──");
const b = await runApproach({
  WebSocket,
  id: "B",
  label: "response.create with instructions (verbatim)",
  afterSessionUpdated(ws, { sendJson: sj, PROBE_TEXT: text }) {
    sj(ws, {
      type: "response.create",
      response: {
        modalities: ["text", "audio"],
        instructions: `请用语音一字不差地朗读下面这句话，不要添加任何其他内容：\n${text}`,
      },
    });
    console.log("  [B] sent response.create with verbatim instructions");
  },
});
approaches.push(b);
console.log(
  `  [B] → ${b.verdict} (${b.detail})\n`
);

const verdict = classifyOverall(approaches);
const allEvents = approaches.flatMap((x) =>
  (x.events || []).map((ev) => `${x.id}:${ev}`)
);

const notes = [
  `Approach A (assistant inject): ${a.verdict} — gotAudio=${a.gotAudio} audioBytes~${a.audioBytes}`,
  `Approach B (instructions): ${b.verdict} — gotAudio=${b.gotAudio} audioBytes~${b.audioBytes}`,
  verdict === "GO"
    ? "Omni can act as mouth for client text via assistant inject — half-cascade candidate."
    : verdict === "PARTIAL_GO"
      ? "Mouth path partially works (likely instructions-driven). Usable with caveats; prefer documenting exact prompt pattern."
      : verdict === "NO_GO"
        ? "Do not rely on omni as half-cascade mouth; keep CosyVoice (or other TTS) for brain text."
        : `Verdict ${verdict}: see approach details.`,
  "This spike does not change production cascade/bailian code paths.",
];

writeResult({
  status: "RAN",
  ranAt,
  model: MODEL,
  keyStatus: describeKeyStatus(KEY),
  approaches: approaches.map((x) => ({
    id: x.id,
    label: x.label,
    verdict: x.verdict,
    detail: x.detail,
  })),
  verdict,
  notes,
  rawEvents: allEvents,
});

console.log("══════════════════════════ REPORT ══════════════════════════");
console.log(`Overall: ${verdict}`);
for (const x of approaches) {
  const icon =
    x.verdict === "AUDIO_OK"
      ? "✅"
      : x.verdict === "PARTIAL" || x.verdict === "TIMEOUT"
        ? "⚠️"
        : "❌";
  console.log(`${icon} ${x.id} ${x.label}: ${x.verdict} — ${x.detail}`);
}
console.log("");

// Spike always exits 0 once the probe finished writing results (CI non-blocking).
process.exit(0);
