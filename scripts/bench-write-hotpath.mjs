#!/usr/bin/env node
// ═══ R3 · 热点写路由压测闸门(不进 CI,手动跑)══════════════════════════════════════════
//
// 用法:
//   node scripts/bench-write-hotpath.mjs            # 默认 N=8 并发 × M=50 每路
//   node scripts/bench-write-hotpath.mjs --n 8 --m 50 --port 3213
//
// 做什么:
//   起一个完全隔离的 API(memory 档,PRODUCT_ENV_FILE 指向 tmp,与 playwright E2E 同一套
//   隔离 env 组合,绝不碰真实存储/密钥),然后并发压两类写路由并输出 p50/p95/吞吐:
//     (a) 试点(R3 已豁免全局写锁,CAS commit 经写门):PATCH /api/memory-candidates/:id
//     (b) 对照(仍整段持有全局写锁):        POST /api/interview-sessions/:id/control
//   两类都是"纯同步小 RMW + 返回整状态"的等价形状,可比。
//   公平性:每个阶段(串行探针/并发压测)开跑前都把 state 恢复到同一份基线快照,消除
//   "前一阶段把 state 越写越大"的串扰;control 在自己阶段内仍会逐发追加控制轮(该路由的
//   固有行为),数字口径里已注明。
//   每类先串行 20 发测单请求延迟,给出"全局锁串行的理论下界(单请求延迟 × 总请求数)"作参照。
//
// 怎么读数字(结论口径,与 R3 报告一致):
//   - 试点路由的 handler(校验/embed 等)已并行化,commit 是微秒级门内同步块 → 并发总时长
//     贴近"单请求延迟 × 串行 commit 数",不再是"整请求端到端 × 总数"的全串行;
//   - 对照路由整请求(含响应整状态序列化)都在锁内 → 并发总时长 ≈ 串行理论下界;
//   - 试点相对对照的收益主要体现在 p95/wall(不用等完前面整条请求,只等微秒级 commit)。
//
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const N = Number(arg("n", "8"));       // 并发 lane 数
const M = Number(arg("m", "50"));      // 每 lane 请求数
const PORT = Number(arg("port", "3213"));
const BASE = `http://127.0.0.1:${PORT}`;

// ── 起隔离 API(env 组合对齐 playwright.config.ts 的 F-02/A2 双保险)─────────────────────
// 单进程:node --import tsx 直跑(tsx>=4),不经 .bin/tsx 包一层——否则 kill 只杀得掉包装层,
// 真 API 变孤儿继续占端口,stderr 管道还会拴着本脚本不退出(实测教训)。
function startIsolatedApi() {
  const envFile = join(mkdtempSync(join(tmpdir(), "zhuanfang-bench-")), "bench.env.local");
  const child = spawn(process.execPath, ["--import", "tsx", "apps/api/src/server.ts"], {
    cwd: ROOT,
    detached: true, // 自成进程组,收尾可整组击杀
    stdio: ["ignore", "ignore", "pipe"],
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: "127.0.0.1",
      PRODUCT_STORE: "memory",
      PRODUCT_STATE_DB_PATH: "memory",
      PRODUCT_ENV_FILE: envFile,
      DASHSCOPE_API_KEY: "",
      BAILIAN_API_KEY: "",
      ANYSEARCH_API_KEY: "",
      TAVILY_API_KEY: "",
      EXA_API_KEY: "",
      BRAVE_SEARCH_API_KEY: "",
      BAILIAN_REALTIME_WEBRTC_ENDPOINT: "",
      EMBEDDING_PROVIDER: "",
      NODE_ENV: "development"
    }
  });
  child.on("error", (err) => {
    console.error(`[bench] API 进程启动失败:${err.message}`);
    process.exit(1);
  });
  child.stderr.on("data", (d) => {
    const line = String(d).trim();
    if (line) console.error(`[api] ${line.slice(0, 400)}`);
  });
  return child;
}

function killApiGroup(child) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, "SIGKILL"); // 整组击杀(防孤儿占端口)
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      /* 已退出 */
    }
  }
}

async function waitForHealth(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(2_000) });
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("API did not become healthy in time");
}

async function json(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000) // 真挂死时响亮失败,不无限等
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// ── 统计 ───────────────────────────────────────────────────────────────────────────────
function pct(sorted, p) {
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}
function summarize(label, durationsMs, wallMs, singleMeanMs) {
  const sorted = [...durationsMs].sort((a, b) => a - b);
  const total = durationsMs.length;
  const mean = durationsMs.reduce((s, v) => s + v, 0) / total;
  const serialLowerBound = singleMeanMs * total; // 全局锁串行的理论下界:单请求延迟 × 总请求数
  return {
    label,
    requests: total,
    concurrency: N,
    "p50(ms)": +pct(sorted, 50).toFixed(2),
    "p95(ms)": +pct(sorted, 95).toFixed(2),
    "max(ms)": +pct(sorted, 100).toFixed(2),
    "mean(ms)": +mean.toFixed(2),
    "wall(ms)": +wallMs.toFixed(1),
    "throughput(req/s)": +((total / wallMs) * 1000).toFixed(1),
    "single(ms)": +singleMeanMs.toFixed(2),
    "serial-lower-bound(ms)": +serialLowerBound.toFixed(1)
  };
}

/** lane 内串行、lane 间并发;返回每请求耗时数组与总墙钟。fire(lane, i) 须抛错即失败。 */
async function runConcurrent(fire) {
  const durations = [];
  const started = performance.now();
  await Promise.all(
    Array.from({ length: N }, (_, lane) =>
      (async () => {
        for (let i = 0; i < M; i++) {
          const t0 = performance.now();
          await fire(lane, i);
          durations.push(performance.now() - t0);
        }
      })()
    )
  );
  return { durations, wallMs: performance.now() - started };
}

async function runSerialProbe(fire, count = 20) {
  const durations = [];
  for (let i = 0; i < count; i++) {
    const t0 = performance.now();
    await fire(0, i);
    durations.push(performance.now() - t0);
  }
  return durations.reduce((s, v) => s + v, 0) / durations.length;
}

// ── 主流程 ─────────────────────────────────────────────────────────────────────────────
const api = startIsolatedApi();
process.on("exit", () => killApiGroup(api));

try {
  await waitForHealth();

  // 种子:N 条 pending 候选(试点工作负载,PATCH 文本可反复打同一实体)+ N 个会话(对照工作负载)。
  const state = await json("GET", "/api/state");
  const candidates = Array.from({ length: N }, (_, i) => ({
    id: `bench-cand-${i}`,
    text: `bench 候选 ${i}`,
    status: "pending",
    sourceType: "interview_session",
    sourceId: "bench",
    evidenceQuote: "",
    reason: "bench 种子",
    sensitivity: "normal",
    reviewScore: 0.5,
    reviewSignals: [],
    createdAt: new Date().toISOString()
  }));
  await json("PUT", "/api/state", { ...state, memoryCandidates: [...candidates, ...(state.memoryCandidates ?? [])] });
  const sessionIds = [];
  for (let i = 0; i < N; i++) {
    const created = await json("POST", "/api/interview-sessions", { topicHint: `bench-${i}` });
    sessionIds.push(created.session.id);
  }

  // 基线快照:每个阶段开跑前恢复,消除阶段间 state 体积串扰(公平对比的前提)。
  const baseline = await json("GET", "/api/state");
  async function restoreBaseline() {
    const current = await json("GET", "/api/state");
    await json("PUT", "/api/state", { ...baseline, revision: current.revision });
  }

  // 对照组(锁内):POST /:id/control(整请求持全局写 slot;固有行为:每发追加一条控制轮)
  const fireControl = (lane, i) =>
    json("POST", `/api/interview-sessions/${sessionIds[lane]}/control`, { action: i % 2 === 0 ? "softer" : "sharper" });
  // 试点组(豁免+CAS):PATCH /api/memory-candidates/:id(文本原地改,state 体积恒定)
  const firePilot = (lane, i) =>
    json("PATCH", `/api/memory-candidates/bench-cand-${lane}`, { text: `bench 第 ${i} 次编辑 lane${lane}` });

  console.log(`\n串行探针(每类 20 发,测单请求延迟;每阶段前恢复基线快照)…`);
  await restoreBaseline();
  const controlSingle = await runSerialProbe(fireControl);
  await restoreBaseline();
  const pilotSingle = await runSerialProbe(firePilot);

  console.log(`并发压测:N=${N} lanes × M=${M} 每 lane,每类共 ${N * M} 请求…`);
  await restoreBaseline();
  const control = await runConcurrent(fireControl);
  await restoreBaseline();
  const pilot = await runConcurrent(firePilot);

  const rows = [
    summarize("对照·锁内 POST /control", control.durations, control.wallMs, controlSingle),
    summarize("试点·CAS PATCH /memory-candidates", pilot.durations, pilot.wallMs, pilotSingle)
  ];
  console.table(rows);
  console.log(
    "口径:serial-lower-bound = 单请求延迟 × 总请求数(全局锁全串行时 wall 的理论下界);\n" +
      "试点 wall/p95 低于对照 = 换轨收益(handler 并行 + 微秒级门内 commit)。\n" +
      "★收益归属(重要):对‘纯同步小 RMW’(如本脚本的 PATCH),换轨对并发延迟的节省≈0——\n" +
      "  这类请求成本几乎全在 commit(clone+normalize)+整状态响应序列化,豁免不改变该成本,\n" +
      "  故本表两行接近是预期、不是回归。R3 真正省下的是两件本表测不到的事:\n" +
      "  ① handler 里的慢 IO(如 PATCH 记忆记录的 embedding,数百 ms)不再持全局写 slot 阻塞他人;\n" +
      "  ② 校验类失败(422/404)不排在长写队尾、即时返回(见 r3-cas-pilot 的 D3 场景测试)。\n" +
      "已知不对称:control 每发追加一条控制轮(state 在其阶段内单调变大,固有行为),\n" +
      "试点 PATCH 文本原地改(体积恒定);两阶段起点均为同一基线快照。"
  );
} finally {
  killApiGroup(api);
}
