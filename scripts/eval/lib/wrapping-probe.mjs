/**
 * Wrapping probe order helper. Writes are illegal until read-only proof succeeds.
 */
import {
  looksLikeOwnerBook,
  witnessSharesOwnerBook
} from "./looks-like-owner-book.mjs";
import { assertEvalProcessSafe, isQingBlueHost, isEvalUsernameAllowed } from "./purge-guard.mjs";

export { looksLikeOwnerBook, witnessSharesOwnerBook };

export const WRITE_ACTIONS = new Set(["put_marker", "purge", "put_fixture", "create_session"]);

export function parseOnFlag(value) {
  return /^(1|true|yes|on)$/i.test(String(value ?? "").trim());
}

/**
 * Pure state machine. `phase` is work already completed (no writes implied).
 * facts are already-fetched; this function never performs I/O.
 *
 * @param {'start'|'flags_ok'|'sim_gotten'|'witness_gotten'|'marker_put'|'proven'} phase
 */
export function nextProbeAction(phase, facts) {
  if (facts?.tokenPresent) {
    return { action: "abort", code: 2, reason: "PRODUCT_API_TOKEN_present", writes: false };
  }
  if (phase === "start") {
    if (facts?.isPublicDemo) {
      if (facts.sshFlagsOk === true) {
        return { action: "get_sim", code: 0, reason: "readonly_get_sim", writes: false };
      }
      if (facts.sshFlagsOk === false) {
        return { action: "abort", code: 2, reason: "wrapping_flags_off", writes: false };
      }
      return { action: "ssh_flags", code: 0, reason: "need_ssh_flags", writes: false };
    }
    return { action: "get_sim", code: 0, reason: "readonly_get_sim", writes: false };
  }
  if (phase === "sim_gotten") {
    if (facts?.simLooksLikeOwner) {
      return { action: "abort", code: 2, reason: "looksLikeOwnerBook", writes: false };
    }
    return { action: "get_witness", code: 0, reason: "readonly_get_witness", writes: false };
  }
  if (phase === "witness_gotten") {
    if (facts?.witnessSharesOwnerBook) {
      return { action: "abort", code: 2, reason: "shared_hot_state", writes: false };
    }
    return { action: "put_marker", code: 0, reason: "readonly_proof_passed", writes: true };
  }
  if (phase === "marker_put") {
    if (facts?.witnessSeesMarker) {
      return { action: "abort", code: 2, reason: "witness_sees_marker", writes: false };
    }
    return { action: "allow_writes", code: 0, reason: "wrapping_proven", writes: false };
  }
  return { action: "abort", code: 2, reason: "unknown_phase", writes: false };
}

export function assertWriteAfterReadonly(completedActions, nextAction) {
  const writesSeen = completedActions.filter((a) => WRITE_ACTIONS.has(a));
  if (writesSeen.length && !completedActions.includes("get_sim") && nextAction !== "abort") {
    throw new Error("write before get_sim");
  }
  const idxGetSim = completedActions.indexOf("get_sim");
  const idxGetWitness = completedActions.indexOf("get_witness");
  const idxPut = completedActions.indexOf("put_marker");
  if (idxPut !== -1 && (idxGetSim === -1 || idxGetWitness === -1 || idxPut < idxGetSim || idxPut < idxGetWitness)) {
    throw new Error("put_marker before readonly GET proof");
  }
}

export function markerVisibleInState(state, marker) {
  return String(state?.profile?.name ?? "") === String(marker);
}

async function sshPrintenv(env) {
  const { spawn } = await import("node:child_process");
  const host = String(env.EVAL_SSH_HOST ?? "").trim();
  const key = String(env.EVAL_SSH_KEY ?? "").trim();
  if (!host || !key) {
    return {
      code: 1,
      out: "",
      err: "EVAL_SSH_HOST and EVAL_SSH_KEY must be set; do not hardcode deploy SSH in the repo"
    };
  }
  const container = env.EVAL_SSH_CONTAINER || "app-zhuanfang-1";
  const args = [
    "-i",
    key,
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=12",
    "-o",
    "StrictHostKeyChecking=accept-new",
    host,
    `docker exec ${container} printenv PRODUCT_AUTH_ENABLED PRODUCT_USER_SCOPED_STATE`
  ];
  return await new Promise((resolve) => {
    const child = spawn("ssh", args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => {
      out += d.toString();
    });
    child.stderr.on("data", (d) => {
      err += d.toString();
    });
    child.on("close", (code) => {
      resolve({ code, out, err });
    });
    child.on("error", (e) => {
      resolve({ code: 1, out, err: String(e) });
    });
  });
}

export function parseSshFlagOutput(text) {
  const lines = String(text ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  // printenv KEY prints "value" per line in KEY order, or KEY=value
  const values = [];
  for (const line of lines) {
    const m = line.match(/^[A-Z_]+=(.*)$/);
    values.push(m ? m[1] : line);
  }
  const auth = parseOnFlag(values[0]);
  const scoped = parseOnFlag(values[1]);
  return { auth, scoped, bothOn: auth && scoped, raw: text };
}

/**
 * Execute the probe. `client` must expose login/getState/putState with a journal of writes.
 * Returns { proven, runId, marker, flags } or throws with exitCode 2 and zero writes expected
 * from the caller (this function itself will not PUT until GET proof).
 */
export async function runWrappingProbe({ env = process.env, client, log = console.log } = {}) {
  assertEvalProcessSafe(env);
  const apiBase = client.apiBase;
  const isPublic = isQingBlueHost(apiBase);
  const completed = [];
  let sshFlagsOk = !isPublic;

  if (isPublic) {
    const envAuth = env.EVAL_WRAPPING_AUTH;
    const envScoped = env.EVAL_WRAPPING_SCOPED;
    if (envAuth != null && envScoped != null && String(envAuth) !== "" && String(envScoped) !== "") {
      sshFlagsOk = parseOnFlag(envAuth) && parseOnFlag(envScoped);
      log(JSON.stringify({ event: "eval_wrapping_flags", auth: parseOnFlag(envAuth), scoped: parseOnFlag(envScoped), source: "env" }));
    } else {
    const ssh = await sshPrintenv(env);
    const parsed = parseSshFlagOutput(ssh.out);
    log(JSON.stringify({ event: "eval_wrapping_flags", auth: parsed.auth, scoped: parsed.scoped, source: "ssh", exit: ssh.code }));
    sshFlagsOk = ssh.code === 0 && parsed.bothOn;
    }
    const decision = nextProbeAction("start", {
      tokenPresent: false,
      isPublicDemo: true,
      sshFlagsOk
    });
    if (decision.action === "abort") {
      throw Object.assign(new Error(JSON.stringify({ event: "eval_purge_blocked", reason: decision.reason })), {
        exitCode: 2,
        evalRefuse: true,
        reason: decision.reason
      });
    }
    completed.push("ssh_flags");
  }

  const simUser = String(env.EVAL_USERNAME ?? "eval_sim").trim();
  const witnessUser = String(env.EVAL_WITNESS_USERNAME ?? "eval_witness").trim();
  if (!isEvalUsernameAllowed(simUser, env) || !isEvalUsernameAllowed(witnessUser, env)) {
    throw Object.assign(new Error(JSON.stringify({ event: "eval_purge_blocked", reason: "forbidden_eval_username" })), {
      exitCode: 2,
      evalRefuse: true,
      reason: "forbidden_eval_username"
    });
  }

  await client.login(simUser, env.EVAL_PASSWORD);
  const me = await client.me();
  if (me !== simUser) {
    throw Object.assign(new Error(JSON.stringify({ event: "eval_purge_blocked", reason: "auth_me_mismatch" })), {
      exitCode: 2,
      evalRefuse: true,
      reason: "auth_me_mismatch"
    });
  }

  const getDecision = nextProbeAction("start", { tokenPresent: false, isPublicDemo: isPublic, sshFlagsOk: true });
  if (getDecision.action !== "get_sim" && isPublic === false) {
    // local: start → get_sim
  }
  const simState = await client.getState();
  completed.push("get_sim");
  const simLooksLikeOwner = looksLikeOwnerBook(simState);
  log(JSON.stringify({ event: "eval_wrapping_readonly", looksLikeOwnerBook: simLooksLikeOwner, witnessSharesOwnerBook: false }));
  const afterSim = nextProbeAction("sim_gotten", { simLooksLikeOwner });
  if (afterSim.action === "abort") {
    throw Object.assign(new Error(JSON.stringify({ event: "eval_purge_blocked", reason: afterSim.reason })), {
      exitCode: 2,
      evalRefuse: true,
      reason: afterSim.reason
    });
  }

  await client.login(witnessUser, env.EVAL_WITNESS_PASSWORD);
  const witnessState = await client.getState();
  completed.push("get_witness");
  const shared = witnessSharesOwnerBook(simState, witnessState);
  log(JSON.stringify({ event: "eval_wrapping_readonly", looksLikeOwnerBook: simLooksLikeOwner, witnessSharesOwnerBook: shared }));
  const afterWitness = nextProbeAction("witness_gotten", { witnessSharesOwnerBook: shared });
  if (afterWitness.action === "abort") {
    throw Object.assign(new Error(JSON.stringify({ event: "eval_purge_blocked", reason: afterWitness.reason })), {
      exitCode: 2,
      evalRefuse: true,
      reason: afterWitness.reason
    });
  }

  assertWriteAfterReadonly(completed, "put_marker");
  const runId = `eval-${Date.now().toString(36)}`;
  const marker = `eval-marker-${runId}`;
  await client.login(simUser, env.EVAL_PASSWORD);
  await client.putOverlay({ profile: { ...(simState.profile ?? {}), name: marker } });
  completed.push("put_marker");

  await client.login(witnessUser, env.EVAL_WITNESS_PASSWORD);
  const witnessAfter = await client.getState();
  const sees = markerVisibleInState(witnessAfter, marker);
  const afterMarker = nextProbeAction("marker_put", { witnessSeesMarker: sees });
  log(JSON.stringify({ event: "eval_wrapping_probe", ok: afterMarker.action === "allow_writes", witnessSeesMarker: sees }));
  if (afterMarker.action === "abort") {
    throw Object.assign(new Error(JSON.stringify({ event: "eval_purge_blocked", reason: afterMarker.reason })), {
      exitCode: 2,
      evalRefuse: true,
      reason: afterMarker.reason
    });
  }

  await client.login(simUser, env.EVAL_PASSWORD);
  return { proven: true, runId, marker, completed };
}
