#!/usr/bin/env node
/**
 * Unified adversarial interview eval driver (Rev D).
 * Default: EVAL_TIER=smoke text against local/demo eval_sim store.
 * Playwright is loaded only when EVAL_MODALITY=voice|both (dynamic import).
 */
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertEvalProcessSafe,
  assertPurgeAllowed,
  defaultEvalApiBase,
  isQingBlueHost,
  printRefuseAndExit
} from "./lib/purge-guard.mjs";
import { createProductClient } from "./lib/product-client.mjs";
import { runWrappingProbe } from "./lib/wrapping-probe.mjs";
import { applyOverlay, clockBlindspotOverlay, clockContradictionOverlay, clockDebtOverlay, clockDecisionOverlay, concreteMomentOverlay, memoryConflictOverlay } from "./lib/fixtures.mjs";
import { guestReply, isCounselorPattern } from "./lib/guest-simulator.mjs";
import { buildScorecard } from "./lib/scorer.mjs";
import { writeCoverageSummary, writeScenarioArtifacts } from "./lib/artifacts.mjs";
import { assertSimulatedGate } from "./lib/simulated-gate.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCENARIO_DIR = join(HERE, "scenarios");

function loadJson(name) {
  return JSON.parse(readFileSync(join(SCENARIO_DIR, name), "utf8"));
}

function loadScenario(id) {
  return loadJson(`${id}.json`);
}

function overlayFor(name) {
  switch (name) {
    case "concrete-moment":
      return concreteMomentOverlay();
    case "clock-debt":
      return clockDebtOverlay();
    case "clock-decision":
      return clockDecisionOverlay();
    case "clock-contradiction":
      return clockContradictionOverlay();
    case "clock-blindspot":
      return clockBlindspotOverlay();
    case "memory-conflict":
      return memoryConflictOverlay();
    default:
      return {};
  }
}

function extractSession(payload) {
  return payload?.session ?? payload;
}

function accumulateMemory(mem, session) {
  const turns = session?.turns ?? [];
  const lastAssistant = [...turns].reverse().find((t) => t.role === "assistant");
  if (lastAssistant && mem.transcript.at(-1)?.content !== lastAssistant.content) {
    mem.transcript.push({ role: "assistant", content: lastAssistant.content, id: lastAssistant.id });
  }
  if (Array.isArray(session?.strategyTrace)) mem.strategyTrace = session.strategyTrace;
  return lastAssistant?.content;
}

async function runInterviewScenario({ client, scenario, env, budgets, isolation, log }) {
  const mem = {
    transcript: [],
    strategyTrace: [],
    doNotSavePosts: 0,
    controlsPosted: [],
    blockedTrue409: false,
    recalledP: false,
    hitlResolved: false
  };

  if (scenario.isolation === "isolate") {
    assertPurgeAllowed({ env, meUsername: await client.me(), wrappingProven: isolation.proven });
    await client.purgeAll();
    budgets.host += 1;
  }
  if (scenario.fixture) {
    const stored = await client.getState();
    const body = applyOverlay(stored, overlayFor(scenario.fixture));
    await client.putState(body);
    budgets.host += 1;
  }

  const created = await client.createSession({
    mode: "daily",
    topicHint: scenario.topicHint || scenario.id
  });
  budgets.host += 1;
  const sessionId = extractSession(created).id;
  let session = extractSession(created);
  let lastHost = [...(session.turns ?? [])].reverse().find((t) => t.role === "assistant")?.content;

  if (scenario.id === "FLOW-memory") {
    return await runFlowMemory({ client, scenario, env, budgets, mem, sessionId, lastHost, log, isolation });
  }

  const maxTurns = Number(scenario.maxUserTurns ?? 8);
  for (let turn = 0; turn < maxTurns; turn++) {
    if (budgets.host >= budgets.hostMax) {
      mem.budgetStop = true;
      break;
    }
    const reply = await guestReply({
      scenario,
      turnIndex: turn,
      lastHost,
      history: mem.transcript.map((t) => ({
        role: t.role === "assistant" ? "user" : "assistant",
        content: t.content
      })),
      env,
      guestCalls: budgets
    });
    mem.transcript.push({ role: "user", content: reply.text });
    const turnRes = await client.postTurn(sessionId, reply.text);
    budgets.host += 1;
    session = extractSession(turnRes);
    lastHost = accumulateMemory(mem, session) || lastHost;

    if (reply.behavior?.kind === "shame_contract" && (scenario.expect?.driver_action ?? []).includes("optional_softer_after_shame")) {
      try {
        await client.postControl(sessionId, "softer");
        budgets.host += 1;
        mem.controlsPosted.push("softer");
        mem.driver_action = "optional_softer_after_shame";
      } catch {
        /* optional */
      }
    }
    if (reply.behavior?.kind === "do_not_write" && mem.doNotSavePosts === 0) {
      await client.postControl(sessionId, "do-not-save");
      budgets.host += 1;
      mem.doNotSavePosts = 1;
      mem.controlsPosted.push("do-not-save");
    }
    if (Array.isArray(scenario.controls) && turn < scenario.controls.length) {
      const action = scenario.controls[turn];
      await client.postControl(sessionId, action);
      budgets.host += 1;
      mem.controlsPosted.push(action);
    }
    if (lastHost && isCounselorPattern(lastHost) && scenario.expect?.host?.mustNot?.includes("advice_list")) {
      mem.adviceList = true;
    }
  }

  let endResult = {};
  if (scenario.endPath === "do-not-save" || scenario.expect?.system?.endPath === "do-not-save") {
    if (mem.doNotSavePosts !== 1) {
      await client.postControl(sessionId, "do-not-save");
      budgets.host += 1;
      mem.doNotSavePosts = 1;
    }
    endResult = await client.endSession(sessionId);
    budgets.host += 1;
  } else if (scenario.endPath !== "none") {
    endResult = await client.endSession(sessionId);
    budgets.host += 1;
  }

  return { mem, endResult, sessionId };
}

async function runFlowMemory({ client, scenario, env, budgets, mem, sessionId, lastHost, log, isolation }) {
  const reply = await guestReply({ scenario, turnIndex: 0, lastHost, env, guestCalls: budgets });
  mem.transcript.push({ role: "user", content: reply.text });
  const turnRes = await client.postTurn(sessionId, reply.text);
  budgets.host += 1;
  accumulateMemory(mem, extractSession(turnRes));
  const ended = await client.endSession(sessionId);
  budgets.host += 1;
  const state = await client.getState();
  const pending = (state.memoryCandidates ?? []).filter((c) => c.status === "pending" && c.suggestedUpdate !== "conflict");
  if (pending[0]) {
    try {
      await client.approveMemory(pending[0].id, { mode: "add" });
      budgets.host += 1;
    } catch (err) {
      log(JSON.stringify({ event: "eval_flow_approve_s1", error: err.message }));
    }
  }

  const stored = await client.getState();
  const overlay = memoryConflictOverlay();
  const existing = Array.isArray(stored.memoryCandidates) ? stored.memoryCandidates : [];
  overlay.memoryCandidates = [...existing.filter((c) => c.id !== overlay.memoryCandidates[0].id), ...overlay.memoryCandidates];
  await client.putState(applyOverlay(stored, overlay));
  budgets.host += 1;
  try {
    await client.approveMemory("c_eval_conflict", { mode: "add" });
    mem.blockedTrue409 = false;
  } catch (err) {
    mem.blockedTrue409 = err.status === 409 && err.body?.blocked === true;
  }
  const after = await client.getState();
  const stillPending = (after.memoryCandidates ?? []).find((c) => c.id === "c_eval_conflict");
  const leaked = (after.memoryRecords ?? []).some((r) => r.sourceCandidateId === "c_eval_conflict");
  if (stillPending?.status !== "pending" || leaked) mem.blockedTrue409 = false;

  const created2 = await client.createSession({ mode: "daily", topicHint: "FLOW-memory-s2" });
  budgets.host += 1;
  const id2 = extractSession(created2).id;
  const neg = "现场其实比远程重要，我把以前那句收回。";
  await client.postTurn(id2, neg);
  budgets.host += 1;
  mem.transcript.push({ role: "user", content: neg });
  const s2 = await client.getState();
  const sess2 = (s2.sessions ?? []).find((s) => s.id === id2);
  const guideBlob = JSON.stringify(sess2?.guide ?? {});
  mem.recalledP = /远程优于现场/.test(guideBlob) || /远程/.test(guideBlob);
  try {
    await client.consolidateQueue();
    budgets.host += 1;
    mem.hitlResolved = true;
  } catch {
    mem.hitlResolved = false;
  }
  return { mem, endResult: ended, sessionId };
}

function pickPack(tier) {
  if (tier === "full") return loadJson("pack.full.json");
  return loadJson("pack.smoke.json");
}

async function main() {
  const env = process.env;
  const log = (...a) => process.stdout.write(a.join(" ") + "\n");
  try {
    assertEvalProcessSafe(env);
  } catch (err) {
    printRefuseAndExit(err, console.error);
    return;
  }

  const apiBase = defaultEvalApiBase(env);
  if (isQingBlueHost(apiBase) && !String(env.EVAL_PASSWORD ?? "").trim()) {
    log(JSON.stringify({ event: "eval_purge_blocked", reason: "qing_blue_requires_eval_login" }));
    process.exit(2);
  }

  const modality = String(env.EVAL_MODALITY ?? "text");
  if (modality !== "text" && modality !== "voice" && modality !== "both") {
    console.error("EVAL_MODALITY must be text|voice|both");
    process.exit(2);
  }

  const journal = { calls: [] };
  const client = createProductClient({ apiBase, journal });
  const tier = String(env.EVAL_TIER ?? "smoke");
  if (tier === "populate") {
    console.error("populate is not the capability eval; refusing default 20k battery");
    process.exit(2);
  }

  try {
    await client.health();
  } catch (err) {
    const writes = client.writes();
    log(JSON.stringify({ event: "eval_api_unreachable", error: err.message, writes: writes.length }));
    if (writes.length) {
      console.error("refusing: writes occurred before API ready");
      process.exit(2);
    }
    process.exit(2);
  }

  if (!String(env.EVAL_PASSWORD ?? "").trim() || !String(env.EVAL_WITNESS_PASSWORD ?? "").trim()) {
    const writes = client.writes();
    log(JSON.stringify({ event: "eval_demo_unavailable", reason: "missing_eval_passwords", writes: writes.length }));
    if (writes.length) process.exit(2);
    process.exit(2);
  }

  let isolation;
  try {
    isolation = await runWrappingProbe({ env, client, log });
  } catch (err) {
    const writes = client.writes();
    log(err.message);
    log(JSON.stringify({ event: "eval_wrapping_failed", writes: writes.map((w) => w.path) }));
    process.exit(err.exitCode === 2 ? 2 : 2);
  }

  env.EVAL_ALLOW_PURGE = env.EVAL_ALLOW_PURGE ?? "1";

  const pack = pickPack(tier);
  const budgets = {
    host: 0,
    hostMax: Number(env.EVAL_MAX_HOST_CALLS ?? pack.maxHostCalls ?? 50),
    count: 0
  };
  const runId = isolation.runId;
  const date = new Date().toISOString().slice(0, 10);
  const outDir = join(HERE, "../../docs/superpowers/eval/samples/simulated", `${date}-${runId}`);
  mkdirSync(outDir, { recursive: true });

  const ids = String(env.EVAL_SCENARIO_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const scenarioIds = ids.length ? ids : pack.ids;
  const coverageAll = [];
  const ran = [];

  for (const id of scenarioIds) {
    if (budgets.host >= budgets.hostMax) break;
    const scenario = loadScenario(id);
    log(JSON.stringify({ event: "eval_scenario_start", id }));
    let mem = { transcript: [], strategyTrace: [], doNotSavePosts: 0, controlsPosted: [] };
    let endResult = {};
    let sessionId = "";
    try {
      const ranOne = await runInterviewScenario({
        client,
        scenario,
        env,
        budgets,
        isolation,
        log
      });
      mem = ranOne.mem;
      endResult = ranOne.endResult;
      sessionId = ranOne.sessionId;
    } catch (err) {
      mem.failLoud = { status: err.status, message: String(err.message ?? err).slice(0, 400) };
      log(JSON.stringify({ event: "eval_scenario_fail_loud", id, status: err.status, error: String(err.message ?? err).slice(0, 240) }));
    }
    const state = await client.getState().catch(() => ({}));
    const assets = {
      notes: (state.notes ?? []).filter((n) => n.sessionId === sessionId).length,
      points: (state.points ?? []).filter((p) => p.sourceSessionId === sessionId).length,
      debts: (state.debts ?? []).filter((d) => d.sourceSessionId === sessionId).length
    };
    const scorecard = buildScorecard({
      scenario,
      memory: mem,
      endResult,
      isolation,
      hostCalls: budgets.host,
      assets
    });
    if (mem.failLoud) {
      scorecard.failLoud = mem.failLoud;
      const live = scorecard.coverage.find((c) => c.id === "C-turn-live");
      if (live) {
        live.result = "fail";
        live.note = `create/turn 5xx: ${mem.failLoud.status ?? ""}`;
      }
    }
    assertSimulatedGate(scorecard);
    writeScenarioArtifacts({ rootDir: outDir, scenarioId: id, transcript: mem.transcript, scorecard });
    coverageAll.push(...scorecard.coverage);
    ran.push(id);
    log(JSON.stringify({ event: "eval_scenario_done", id, userTurns: mem.transcript.filter((t) => t.role === "user").length, dns: mem.doNotSavePosts, failLoud: Boolean(mem.failLoud) }));
    await new Promise((r) => setTimeout(r, 2000));
  }

  if (modality === "voice" || modality === "both") {
    const voice = await import("./lib/voice-adapter.mjs");
    const tts = await import("./lib/tts-bridge.mjs");
    for (const id of pack.voiceIds ?? []) {
      const scenario = loadScenario(id);
      const text = scenario.guest?.behaviors?.[0]?.text ?? "评测语音一句。";
      let utterances = [];
      try {
        const fixture = await tts.synthesizeCanonical(text, env);
        utterances = fixture.utterances ?? [];
      } catch (err) {
        log(JSON.stringify({ event: "eval_tts_skip", id, error: err.message }));
      }
      try {
        await voice.deliverVoiceScenario({
          scenario,
          cookie: client.cookie,
          origin: apiBase.replace(/\/$/, ""),
          utterances,
          log
        });
      } catch (err) {
        log(JSON.stringify({ event: "eval_voice_skip", id, error: err.message }));
      }
    }
  }

  writeCoverageSummary(outDir, coverageAll);
  log(JSON.stringify({ event: "eval_run_complete", ran, outDir, hostCalls: budgets.host }));
}

main().catch((err) => {
  console.error(err);
  process.exit(err.exitCode === 2 ? 2 : 1);
});
