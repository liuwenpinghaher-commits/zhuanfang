// scripts/spike-audio3-session.mjs
//
// Purpose (PR-8s · Audio 3.0 session + voice allowlist spike):
//   Probe DashScope **Qwen-Audio-Realtime 3.0** (not Omni drop-in) for:
//     1) WebSocket connect + session.update (text+audio)
//     2) Candidate system voices (Audio3 family ≠ Omni Ethan / Cosy longanyang)
//     3) turn_detection: server_vad vs smart_turn
//     4) One lightweight response path that can emit audio (when key present)
//
// Why:
//   PR-7 reserved profile id `audio3-flash` but keeps PROFILE_BY_ID null until OQ1 freezes
//   model id / smart_turn / voices. This spike gathers live evidence for that freeze.
//   **PR-8 production remains blocked (OQ1)** — do not enable VOICE_BAILIAN_AUDIO3 or
//   register a non-null audio3 profile from this spike alone.
//
// Run:
//   node scripts/spike-audio3-session.mjs
//
// Env:
//   DASHSCOPE_API_KEY from .env.local (or process.env). Missing → exit 0 with SKIPPED
//   (CI-safe) and still write/refresh docs/superpowers/specs/spike-audio3-session-result.md.
//   Optional:
//     SPIKE_AUDIO3_MODELS=comma,list   (default flash,plus candidates)
//     SPIKE_AUDIO3_VOICES=comma,list
//     SPIKE_AUDIO3_TIMEOUT_MS=20000
//     SPIKE_AUDIO3_WS_BASE=wss://dashscope.aliyuncs.com/api-ws/v1/realtime
//
// Does NOT touch production cascade / bailian / profile registration.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describeKeyStatus } from "./lib/redact.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const RESULT_PATH = resolve(
  ROOT,
  "docs/superpowers/specs/spike-audio3-session-result.md"
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

function splitCsv(raw, fallback) {
  const s = (raw ?? "").trim();
  if (!s) return [...fallback];
  return s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

const fileEnv = loadEnv(new URL("../.env.local", import.meta.url));
const KEY = (
  process.env.DASHSCOPE_API_KEY ||
  fileEnv.DASHSCOPE_API_KEY ||
  ""
).trim();

/**
 * Candidate Audio 3.0 model ids (docs: qwen-audio-3.0-realtime-{flash,plus}).
 * Not Omni (`qwen3.5-omni-*-realtime`). Order: flash first (profile name audio3-flash).
 */
const DEFAULT_MODELS = [
  "qwen-audio-3.0-realtime-flash",
  "qwen-audio-3.0-realtime-plus",
];

/**
 * Candidate system voices for Audio3 family (docs default: longanqian).
 * Explicitly **not** Omni (Ethan/Cherry/…) or CosyVoice (longanyang/longanhuan).
 * Spike records which ids are accepted by session.updated vs rejected.
 */
const DEFAULT_VOICES = [
  "longanqian", // documented default for Qwen-Audio Realtime 3.0
  "longanhuan", // name collision risk with Cosy — probe whether Audio3 accepts it
  "Ethan", // Omni default — expect reject or silent ignore; documents non-drop-in
];

const MODELS = splitCsv(
  process.env.SPIKE_AUDIO3_MODELS || fileEnv.SPIKE_AUDIO3_MODELS,
  DEFAULT_MODELS
);
const VOICES = splitCsv(
  process.env.SPIKE_AUDIO3_VOICES || fileEnv.SPIKE_AUDIO3_VOICES,
  DEFAULT_VOICES
);

const WS_BASE = (
  process.env.SPIKE_AUDIO3_WS_BASE ||
  fileEnv.SPIKE_AUDIO3_WS_BASE ||
  "wss://dashscope.aliyuncs.com/api-ws/v1/realtime"
).replace(/\?.*$/, "");

const PROBE_TIMEOUT_MS = Number(
  process.env.SPIKE_AUDIO3_TIMEOUT_MS || fileEnv.SPIKE_AUDIO3_TIMEOUT_MS || 20000
);

const PROBE_TEXT =
  process.env.SPIKE_AUDIO3_TEXT?.trim() ||
  "你好，这是一次 Audio 3.0 辅路径建连探测。";

// ── result markdown ─────────────────────────────────────────────────────────
function renderResultDoc(input) {
  const {
    status, // SKIPPED | RAN | ERROR
    ranAt,
    keyStatus,
    models = [],
    voices = [],
    turnModes = [],
    overallVerdict = "pending",
    notes = [],
    rawEvents = [],
    freezeHints = [],
  } = input;

  const modelRows = models.length
    ? models
        .map(
          (m) =>
            `| \`${m.id}\` | ${m.verdict} | ${String(m.detail || "").replace(/\|/g, "\\|").slice(0, 220)} |`
        )
        .join("\n")
    : "| — | (not run) | — |";

  const voiceRows = voices.length
    ? voices
        .map(
          (v) =>
            `| \`${v.model}\` | \`${v.voice}\` | ${v.verdict} | ${String(v.detail || "").replace(/\|/g, "\\|").slice(0, 180)} |`
        )
        .join("\n")
    : "| — | — | (not run) | — |";

  const turnRows = turnModes.length
    ? turnModes
        .map(
          (t) =>
            `| \`${t.model}\` | \`${t.mode}\` | ${t.verdict} | ${String(t.detail || "").replace(/\|/g, "\\|").slice(0, 180)} |`
        )
        .join("\n")
    : "| — | — | (not run) | — |";

  const eventBlock =
    rawEvents.length > 0
      ? rawEvents
          .slice(0, 100)
          .map((e) => `- \`${e}\``)
          .join("\n")
      : "- (none)";

  const notesBlock =
    notes.length > 0 ? notes.map((n) => `- ${n}`).join("\n") : "- (none)";

  const freezeBlock =
    freezeHints.length > 0
      ? freezeHints.map((n) => `- ${n}`).join("\n")
      : "- (none yet — re-run with key after live probe)";

  return `# Spike: Audio 3.0 session + voice allowlist (PR-8s)

> **Status:** \`${status}\`
> **Ran at:** ${ranAt}
> **API key:** ${keyStatus}
> **Script:** \`scripts/spike-audio3-session.mjs\`
> **WS base:** \`${WS_BASE}?model=...\`
> **OQ1:** **not frozen** → production **PR-8 remains blocked** even if this spike is green

## Purpose

Gather live evidence for DashScope **Qwen-Audio-Realtime 3.0** (profile family \`audio3-flash\`):

| Probe | Question |
|-------|----------|
| Model connect | Which model ids accept WS + \`session.update\` (text+audio)? |
| Voice allowlist | Which system \`voice\` values echo/accept (Audio3 ≠ Omni ≠ Cosy)? |
| Turn detection | Does \`server_vad\` / \`smart_turn\` accept on first update? |
| One audio round | Can a minimal \`response.create\` emit audio deltas? |

**Out of scope / hard rules**

- Does **not** enable \`VOICE_BAILIAN_AUDIO3\` or register non-null \`PROFILE_BY_ID["audio3-flash"]\`.
- Does **not** change default cascade / Omni production paths.
- Spike **GO ≠ merge PR-8** until OQ1 freezes model id + smart_turn + voice allowlist.

## Go / No-Go (for *future* PR-8 design only)

### Evidence GO (spike green — still not production)

1. At least one candidate model connects and accepts \`session.update\` with \`modalities: ["text","audio"]\`.
2. At least one **Audio3-family** system voice is accepted (not only Omni/Cosy ids).
3. At least one turn_detection mode (\`server_vad\` or \`smart_turn\`) is accepted.
4. Optional but strong: one response path yields audio (\`response.audio.delta\` / binary / audio.done).

### NO-GO for Audio3 profile (keep omni-default only)

1. All candidate models reject connect / session.update.
2. No stable system voice for Audio3 (only errors).
3. Protocol incompatible with our realtime event expectations in a way that blocks automation.

### OQ1 freeze checklist (manual)

When product freezes OQ1, fill from this file:

- Primary model id: …
- Fallback model id: …
- Default voice + allowlist: …
- Default turn_detection: …
- Then (and only then) PR-8 may register profile + flag-default-off path.

## Models probed

| Model | Verdict | Detail |
|-------|---------|--------|
${modelRows}

## Voice allowlist probes

| Model | Voice | Verdict | Detail |
|-------|-------|---------|--------|
${voiceRows}

## Turn detection probes

| Model | Mode | Verdict | Detail |
|-------|------|---------|--------|
${turnRows}

## Overall verdict

**\`${overallVerdict}\`**

## Notes

${notesBlock}

## Freeze hints (draft — not frozen)

${freezeBlock}

## Event sample (truncated)

${eventBlock}

## How to re-run

\`\`\`bash
# requires DASHSCOPE_API_KEY in .env.local or env
node scripts/spike-audio3-session.mjs

# optional overrides
SPIKE_AUDIO3_MODELS=qwen-audio-3.0-realtime-flash \\
SPIKE_AUDIO3_VOICES=longanqian \\
SPIKE_AUDIO3_TIMEOUT_MS=25000 \\
node scripts/spike-audio3-session.mjs
\`\`\`

Without a key the script exits **0** with \`SKIPPED\` (CI-safe) and refreshes this template.

## Implication for product

- **SKIPPED** → no live evidence; **do not** merge production Audio3 (PR-8 blocked by OQ1 anyway).
- **EVIDENCE_GO / PARTIAL** → use rows above to draft OQ1 freeze; still **flag-default-off** when implementing PR-8.
- **NO_GO** → keep \`audio3-flash\` profile null; document residual; no production path.
- Cosy cascade default remains the user-facing path (CFC+).

---
*Generated/updated by \`scripts/spike-audio3-session.mjs\`. Do not put secrets in this file.*
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
    return `code=${e.code ?? "?"} msg=${String(e.message || e || "").slice(0, 120)}`;
  }
  if (msg.session) {
    const s = msg.session;
    const bits = [];
    if (s.modalities) bits.push(`modalities=${JSON.stringify(s.modalities)}`);
    if (s.voice) bits.push(`voice=${s.voice}`);
    if (s.turn_detection)
      bits.push(`td=${JSON.stringify(s.turn_detection).slice(0, 80)}`);
    return bits.join(" ");
  }
  if (msg.response?.status) return `status=${msg.response.status}`;
  return "";
}

/**
 * Open one WS for model, optionally run session.update, observe events.
 * opts.session: object | null — if null, only test connect/session.created
 * opts.wantAudio: after update, send response.create with instructions
 */
async function probeSession({ WebSocket, model, label, session, wantAudio }) {
  const url = `${WS_BASE}?model=${encodeURIComponent(model)}`;
  return new Promise((resolve) => {
    const ws = new WebSocket(url, {
      headers: { Authorization: `Bearer ${KEY}` },
    });

    let done = false;
    const events = [];
    const t0 = Date.now();
    let sessionCreated = false;
    let sessionUpdated = false;
    let gotAudio = false;
    let audioBytes = 0;
    let lastError = null;
    let echoedVoice = null;
    let echoedTd = null;

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
        label,
        model,
        verdict,
        detail,
        sessionCreated,
        sessionUpdated,
        gotAudio,
        audioBytes,
        lastError,
        echoedVoice,
        echoedTd,
        events: [...events],
        elapsedMs: Date.now() - t0,
        ...extra,
      });
    };

    const timer = setTimeout(() => {
      finish(
        gotAudio
          ? "PARTIAL"
          : sessionUpdated
            ? "UPDATED_NO_AUDIO"
            : sessionCreated
              ? "CREATED_NO_UPDATE"
              : "TIMEOUT",
        `timeout ${PROBE_TIMEOUT_MS}ms; created=${sessionCreated} updated=${sessionUpdated} gotAudio=${gotAudio} events=${events.slice(-10).join(",")}`
      );
    }, PROBE_TIMEOUT_MS);

    ws.on("open", () => {
      events.push("ws.open");
      console.log(`  [${label}] WS open → ${model}`);
    });

    ws.on("message", (data, isBinary) => {
      if (isBinary || (Buffer.isBuffer(data) && data[0] !== 0x7b)) {
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
        `  [${label}] +${Date.now() - t0}ms ${type}${summary ? " " + summary : ""}`
      );

      if (
        type === "response.audio.delta" ||
        type === "response.output_audio.delta"
      ) {
        gotAudio = true;
        if (typeof msg.delta === "string") {
          audioBytes += Math.floor((msg.delta.length * 3) / 4);
        }
      }

      if (
        type === "response.done" ||
        type === "response.audio.done" ||
        type === "response.output_audio.done"
      ) {
        if (gotAudio) {
          finish(
            "AUDIO_OK",
            `audio ~${audioBytes}B; voiceEcho=${echoedVoice ?? "?"} td=${JSON.stringify(echoedTd ?? "?")}`
          );
          return;
        }
      }

      if (type === "session.created") {
        sessionCreated = true;
        if (session) {
          sendJson(ws, { type: "session.update", session });
          console.log(`  [${label}] session.created → session.update`);
        } else {
          finish("CONNECT_OK", "session.created (no update sent)");
        }
        return;
      }

      if (type === "session.updated") {
        sessionUpdated = true;
        echoedVoice = msg.session?.voice ?? session?.voice ?? null;
        echoedTd = msg.session?.turn_detection ?? session?.turn_detection ?? null;
        if (wantAudio) {
          sendJson(ws, {
            type: "response.create",
            response: {
              modalities: ["text", "audio"],
              instructions: `请用语音简短说一句：${PROBE_TEXT}`,
            },
          });
          console.log(`  [${label}] session.updated → response.create`);
        } else {
          finish(
            "ACCEPTED",
            `session.updated voice=${echoedVoice ?? "?"} td=${JSON.stringify(echoedTd ?? "?")}`
          );
        }
        return;
      }

      if (type === "error") {
        lastError =
          msg?.error?.message ||
          msg?.error?.code ||
          JSON.stringify(msg).slice(0, 200);
        if (!sessionUpdated) {
          finish("REJECTED", `error: ${lastError}`);
        } else {
          console.log(`  [${label}] error after update: ${lastError}`);
        }
      }
    });

    ws.on("unexpected-response", (_req, res) => {
      let body = "";
      res.on("data", (d) => {
        body += d;
      });
      res.on("end", () => {
        finish("HTTP_ERR", `HTTP ${res.statusCode}: ${body.slice(0, 240)}`);
      });
    });

    ws.on("error", (err) => {
      finish("WS_ERR", String(err?.message || err).slice(0, 240));
    });

    ws.on("close", (code, reason) => {
      if (!done) {
        finish(
          gotAudio
            ? "AUDIO_OK"
            : sessionUpdated
              ? "CLOSED_AFTER_UPDATE"
              : "CLOSED",
          `ws close code=${code} reason=${String(reason || "")}`
        );
      }
    });
  });
}

function classifyOverall({ models, voices, turnModes }) {
  if (
    models.every((m) => m.verdict === "SKIPPED") &&
    voices.every((v) => v.verdict === "SKIPPED")
  ) {
    return "SKIPPED";
  }

  const modelOk = models.some((m) =>
    ["CONNECT_OK", "ACCEPTED", "AUDIO_OK", "UPDATED_NO_AUDIO", "PARTIAL"].includes(
      m.verdict
    )
  );
  const voiceOk = voices.some((v) =>
    ["ACCEPTED", "AUDIO_OK", "UPDATED_NO_AUDIO"].includes(v.verdict)
  );
  const turnOk = turnModes.some((t) =>
    ["ACCEPTED", "AUDIO_OK", "UPDATED_NO_AUDIO"].includes(t.verdict)
  );
  const audioOk = [...models, ...voices, ...turnModes].some(
    (x) => x.verdict === "AUDIO_OK" || x.gotAudio
  );

  if (modelOk && voiceOk && turnOk && audioOk) return "EVIDENCE_GO";
  if (modelOk && (voiceOk || turnOk)) return "PARTIAL";
  if (models.some((m) => m.verdict === "HTTP_ERR" || m.verdict === "WS_ERR"))
    return "ERROR";
  if (models.every((m) => m.verdict === "REJECTED" || m.verdict === "HTTP_ERR"))
    return "NO_GO";
  return "NO_GO";
}

function draftFreezeHints({ models, voices, turnModes, overall }) {
  if (overall === "SKIPPED") {
    return [
      "No live run — OQ1 remains unfrozen; PR-8 production stays blocked.",
      "Re-run with DASHSCOPE_API_KEY to populate model/voice/smart_turn candidates.",
    ];
  }
  const okModels = models
    .filter((m) =>
      ["CONNECT_OK", "ACCEPTED", "AUDIO_OK", "UPDATED_NO_AUDIO", "PARTIAL"].includes(
        m.verdict
      )
    )
    .map((m) => m.id);
  const okVoices = voices
    .filter((v) =>
      ["ACCEPTED", "AUDIO_OK", "UPDATED_NO_AUDIO"].includes(v.verdict)
    )
    .map((v) => v.voice);
  const okTurns = turnModes
    .filter((t) =>
      ["ACCEPTED", "AUDIO_OK", "UPDATED_NO_AUDIO"].includes(t.verdict)
    )
    .map((t) => t.mode);

  return [
    okModels.length
      ? `Candidate primary/fallback models (not frozen): ${okModels.join(", ")}`
      : "No accepted model ids yet.",
    okVoices.length
      ? `Candidate voice allowlist (not frozen): ${[...new Set(okVoices)].join(", ")}`
      : "No accepted Audio3 voices yet.",
    okTurns.length
      ? `Candidate turn_detection modes (not frozen): ${[...new Set(okTurns)].join(", ")}`
      : "No accepted turn_detection mode yet.",
    "Do not set VOICE_BAILIAN_AUDIO3=true or register audio3-flash profile until OQ1 freezes.",
  ];
}

// ── main ────────────────────────────────────────────────────────────────────
const ranAt = new Date().toISOString();

console.log("\n=== spike-audio3-session: Audio 3.0 + voice allowlist (PR-8s) ===\n");
console.log(`Models: ${MODELS.join(", ")}`);
console.log(`Voices: ${VOICES.join(", ")}`);
console.log(`Key:    ${describeKeyStatus(KEY)}`);
console.log(`WS:     ${WS_BASE}?model=...`);
console.log(`OQ1:    not frozen → PR-8 production remains blocked\n`);

if (!KEY) {
  const models = MODELS.map((id) => ({
    id,
    verdict: "SKIPPED",
    detail: "no API key",
  }));
  const voices = VOICES.map((voice) => ({
    model: MODELS[0] || "qwen-audio-3.0-realtime-flash",
    voice,
    verdict: "SKIPPED",
    detail: "no API key",
  }));
  const turnModes = [
    {
      model: MODELS[0] || "qwen-audio-3.0-realtime-flash",
      mode: "server_vad",
      verdict: "SKIPPED",
      detail: "no API key",
    },
    {
      model: MODELS[0] || "qwen-audio-3.0-realtime-flash",
      mode: "smart_turn",
      verdict: "SKIPPED",
      detail: "no API key",
    },
  ];
  const notes = [
    "DASHSCOPE_API_KEY missing — live probe skipped (exit 0 for CI).",
    "Fill .env.local and re-run to populate model/voice/smart_turn verdicts.",
    "Production Audio3 flag / profile registration intentionally untouched.",
    "OQ1 still not frozen: PR-8 production remains blocked regardless of this template.",
  ];
  writeResult({
    status: "SKIPPED",
    ranAt,
    keyStatus: describeKeyStatus(KEY),
    models,
    voices,
    turnModes,
    overallVerdict: "SKIPPED",
    notes,
    rawEvents: [],
    freezeHints: draftFreezeHints({
      models,
      voices,
      turnModes,
      overall: "SKIPPED",
    }),
  });
  console.log("SKIPPED: no DASHSCOPE_API_KEY (exit 0)\n");
  process.exit(0);
}

// Dynamic import so SKIPPED path never requires `ws` to be installed.
let WebSocket;
try {
  ({ default: WebSocket } = await import("ws"));
} catch (e) {
  writeResult({
    status: "ERROR",
    ranAt,
    keyStatus: describeKeyStatus(KEY),
    models: MODELS.map((id) => ({
      id,
      verdict: "ERROR",
      detail: `ws import failed: ${String(e?.message || e).slice(0, 120)}`,
    })),
    voices: [],
    turnModes: [],
    overallVerdict: "ERROR",
    notes: [
      `Failed to import 'ws': ${String(e?.message || e)}`,
      "Install deps where appropriate and re-run (not on memory-constrained hosts).",
    ],
    rawEvents: [],
    freezeHints: [
      "Environment error — not an Audio3 protocol verdict.",
      "PR-8 production remains blocked (OQ1).",
    ],
  });
  console.error("ERROR: cannot import ws —", e?.message || e);
  process.exit(0);
}

const modelResults = [];
const voiceResults = [];
const turnResults = [];
const allEvents = [];

// ── 1) Model connect + baseline session.update ──────────────────────────────
console.log("── Phase 1: model connect + session.update ──");
for (const model of MODELS) {
  const r = await probeSession({
    WebSocket,
    model,
    label: `M:${model.split(".").slice(-1)[0] || model}`,
    session: {
      modalities: ["text", "audio"],
      voice: VOICES[0] || "longanqian",
      input_audio_format: "pcm",
      output_audio_format: "pcm",
      turn_detection: { type: "server_vad" },
      instructions: "你是语音助手。简短回答。",
    },
    wantAudio: true,
  });
  modelResults.push({
    id: model,
    verdict: r.verdict,
    detail: r.detail,
    gotAudio: r.gotAudio,
  });
  allEvents.push(...(r.events || []).map((e) => `${model}:${e}`));
  console.log(`  → ${model}: ${r.verdict} (${r.detail})\n`);
}

const primaryModel =
  modelResults.find((m) =>
    ["CONNECT_OK", "ACCEPTED", "AUDIO_OK", "UPDATED_NO_AUDIO", "PARTIAL"].includes(
      m.verdict
    )
  )?.id || MODELS[0];

// ── 2) Voice allowlist on primary model ─────────────────────────────────────
console.log(`── Phase 2: voice allowlist on ${primaryModel} ──`);
for (const voice of VOICES) {
  const r = await probeSession({
    WebSocket,
    model: primaryModel,
    label: `V:${voice}`,
    session: {
      modalities: ["text", "audio"],
      voice,
      input_audio_format: "pcm",
      output_audio_format: "pcm",
      turn_detection: { type: "server_vad" },
      instructions: "你是语音助手。",
    },
    wantAudio: false,
  });
  voiceResults.push({
    model: primaryModel,
    voice,
    verdict: r.verdict,
    detail: r.detail + (r.echoedVoice ? ` echo=${r.echoedVoice}` : ""),
    gotAudio: r.gotAudio,
  });
  allEvents.push(...(r.events || []).map((e) => `voice:${voice}:${e}`));
  console.log(`  → voice=${voice}: ${r.verdict} (${r.detail})\n`);
}

// ── 3) turn_detection modes ─────────────────────────────────────────────────
console.log(`── Phase 3: turn_detection modes on ${primaryModel} ──`);
for (const mode of ["server_vad", "smart_turn"]) {
  const r = await probeSession({
    WebSocket,
    model: primaryModel,
    label: `T:${mode}`,
    session: {
      modalities: ["text", "audio"],
      voice: VOICES[0] || "longanqian",
      input_audio_format: "pcm",
      output_audio_format: "pcm",
      turn_detection: { type: mode },
      instructions: "你是语音助手。",
    },
    wantAudio: false,
  });
  turnResults.push({
    model: primaryModel,
    mode,
    verdict: r.verdict,
    detail: r.detail,
    gotAudio: r.gotAudio,
  });
  allEvents.push(...(r.events || []).map((e) => `td:${mode}:${e}`));
  console.log(`  → turn_detection=${mode}: ${r.verdict} (${r.detail})\n`);
}

const overallVerdict = classifyOverall({
  models: modelResults,
  voices: voiceResults,
  turnModes: turnResults,
});

const notes = [
  `Primary model used for voice/td probes: ${primaryModel}`,
  `Overall: ${overallVerdict}`,
  overallVerdict === "EVIDENCE_GO"
    ? "Live evidence sufficient to draft OQ1 freeze candidates — still do NOT merge PR-8 until freeze + flag-off design."
    : overallVerdict === "PARTIAL"
      ? "Partial protocol acceptance — document accepted rows; do not freeze OQ1 from partial alone without product review."
      : overallVerdict === "NO_GO"
        ? "Audio3 path not viable with current candidates — keep profile null, PR-8 stays blocked."
        : `Verdict ${overallVerdict}.`,
  "This spike does not enable VOICE_BAILIAN_AUDIO3 or change realtime-model-profile registration.",
  "Omni and Cosy production defaults remain unchanged (CFC+).",
];

writeResult({
  status: "RAN",
  ranAt,
  keyStatus: describeKeyStatus(KEY),
  models: modelResults,
  voices: voiceResults,
  turnModes: turnResults,
  overallVerdict,
  notes,
  rawEvents: allEvents,
  freezeHints: draftFreezeHints({
    models: modelResults,
    voices: voiceResults,
    turnModes: turnResults,
    overall: overallVerdict,
  }),
});

console.log("══════════════════════════ REPORT ══════════════════════════");
console.log(`Overall: ${overallVerdict}`);
for (const m of modelResults) {
  console.log(`  model ${m.id}: ${m.verdict}`);
}
for (const v of voiceResults) {
  console.log(`  voice ${v.voice}: ${v.verdict}`);
}
for (const t of turnResults) {
  console.log(`  td ${t.mode}: ${t.verdict}`);
}
console.log("PR-8 production remains blocked (OQ1 not frozen).\n");

// Spike always exits 0 once the probe finished writing results (CI non-blocking).
process.exit(0);
