import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProductStateRepositoryContract } from "../repository-contract";
import { createSurrealProductStateRepository, type SurrealRepoHandle } from "./surreal-product-state-repository";
import { runScript } from "./child-process-test-utils";
import type { InterviewSession } from "../../../../src/domain/types";

/** 最小合规 InterviewSession fixture:满足 SCHEMAFULL session 表的必填字段。 */
function makeSession(id: string, turns: InterviewSession["turns"] = []): InterviewSession {
  return {
    id, title: "测试会话", mode: "daily" as const, strength: "standard" as const,
    status: "active" as const, startedAt: "2026-06-27T00:00:00.000Z",
    card: {} as InterviewSession["card"], guide: {} as InterviewSession["guide"],
    turns,
  };
}

const open = new Set<SurrealRepoHandle>();
async function makeMem(): Promise<SurrealRepoHandle> {
  const repo = await createSurrealProductStateRepository({ url: "mem://" });
  open.add(repo);
  return repo;
}
afterEach(async () => { for (const r of open) await r.close(); open.clear(); });

describe("contract: surreal (mem://)", () => {
  runProductStateRepositoryContract(
    makeMem,
    (repo) => (repo as SurrealRepoHandle).flush()
  );
});

// runScript(tsx 子进程跑 .mts;surrealkv 文件锁约束)已提炼到 child-process-test-utils.ts,
// 与 r1a-entities.test.ts 共用。

describe("surreal persistence (surrealkv://)", () => {
  it("replaceState→flush→重开,资产无损重建 (子进程验证,跨进程持久化)", { timeout: 60000 }, () => {
    const dir = mkdtempSync(join(tmpdir(), "surreal-p1a-"));
    try {
      const url = `surrealkv://${dir}/surreal`;
      const repoSrc = JSON.stringify(join(process.cwd(), "packages/db/src/surreal/surreal-product-state-repository.ts"));

      // ── Write phase: child process 1 ──────────────────────────────────────
      const writeResult = runScript(`
import { createSurrealProductStateRepository } from ${repoSrc};
const repo = await createSurrealProductStateRepository({ url: ${JSON.stringify(url)} });
const base = repo.getState();
repo.replaceState({ ...base,
  themes: [...base.themes, {
    id: "th_kv", name: "KV主题", summary: "摘要", maturity: "聚焦" as const,
    representativeQuote: "", appearances: 1, nextQuestion: "", updatedAt: "2026-06-27T00:00:00.000Z"
  }],
  points: [{ id: "pt_kv", title: "持久化", content: "c", status: "已修正" as const,
    confidence: "用户确认" as const, evidence: ["x"], relatedThemeIds: ["th_kv"],
    important: true, updatedAt: "2026-06-27T00:00:00.000Z" }]
});
await repo.flush();
await repo.close();
console.log("ok");
process.exit(0);
`, join(dir, "writer.mts"));

      if (writeResult.status !== 0) {
        throw new Error(`Write process failed (exit ${writeResult.status}):\n${writeResult.stderr}`);
      }

      // ── Read phase: child process 2 ────────────────────────────────────────
      const readResult = runScript(`
import { createSurrealProductStateRepository } from ${repoSrc};
const repo = await createSurrealProductStateRepository({ url: ${JSON.stringify(url)} });
const state = repo.getState();
const pt = state.points.find((p: { id: string }) => p.id === "pt_kv");
const th = state.themes.find((t: { id: string }) => t.id === "th_kv");
// P0 B:loadState 从 DB 读回 datetime 列后,updatedAt 必须 coerce 回 string(非 DateTime 对象)。
// 必须在子进程内、JSON.stringify 之前捕获 typeof——JSON 会把 DateTime 也转成 ISO 字符串而掩盖问题。
console.log(JSON.stringify({ pt, th, ptUpdatedAtType: typeof pt?.updatedAt }));
await repo.close();
process.exit(0);
`, join(dir, "reader.mts"));

      if (readResult.status !== 0) {
        throw new Error(`Read process failed (exit ${readResult.status}):\n${readResult.stderr}`);
      }

      const jsonLine = readResult.stdout.trim().split("\n").filter((l) => l.startsWith("{")).at(-1) ?? "{}";
      const parsed = JSON.parse(jsonLine) as {
        pt?: { title: string; relatedThemeIds: string[]; evidence: string[] };
        th?: { id: string };
        ptUpdatedAtType?: string;
      };
      expect(parsed.pt?.title, "point title persisted").toBe("持久化");
      expect(parsed.pt?.relatedThemeIds, "relatedThemeIds (rest) persisted").toEqual(["th_kv"]);
      expect(parsed.pt?.evidence, "evidence (rest) persisted").toEqual(["x"]);
      expect(parsed.th?.id, "theme persisted").toBe("th_kv");
      // P0 B 真实 reload 验证:跨进程 loadState 从 DB datetime 列读回后,updatedAt 被 coerce 回 string
      //(非 DateTime 对象)。这是 mem:// getState(返回内存副本)测不到、只有真实 DB reload 才暴露的路径。
      expect(parsed.ptUpdatedAtType, "P0 B: loadState 日期 coerce 回 string").toBe("string");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("surreal graph edges (mem://)", () => {
  it("belongs_to_theme 入边:point + decision + question 一次拿全(含曾漏 decisions 回归)", async () => {
    const repo = await makeMem();
    const base = repo.getState();
    repo.replaceState({ ...base,
      themes: [{ id: "th_1", name: "放权", summary: "", maturity: "聚焦" as const, representativeQuote: "", appearances: 1, nextQuestion: "", updatedAt: "2026-06-27T00:00:00.000Z" }],
      points: [{ id: "pt_1", title: "t", content: "c", status: "稳定观点" as const, confidence: "用户确认" as const, evidence: [], relatedThemeIds: ["th_1"], important: false, updatedAt: "2026-06-27T00:00:00.000Z" }],
      decisions: [{ id: "de_1", title: "t", decisionKind: "用户决策" as const, confirmationStatus: "用户确认" as const, choice: "c", tradeOff: "", riskHypothesis: "", reviewAt: "", status: "待复盘" as const, updatedAt: "2026-06-27T00:00:00.000Z", relatedThemeIds: ["th_1"] }],
      questions: [{ id: "qu_1", question: "q", whyImportant: "", status: "开放" as const, appearances: 1, relatedThemeIds: ["th_1"], nextPrompt: "", important: false, updatedAt: "2026-06-27T00:00:00.000Z" }]
    });
    await repo.flush();
    const [pts] = await repo.query<[unknown[]]>("SELECT VALUE <-belongs_to_theme<-point FROM theme:th_1;");
    const [decs] = await repo.query<[unknown[]]>("SELECT VALUE <-belongs_to_theme<-decision FROM theme:th_1;");
    const [qus] = await repo.query<[unknown[]]>("SELECT VALUE <-belongs_to_theme<-question FROM theme:th_1;");
    expect((pts?.[0] as unknown[] ?? []).length).toBe(1);
    expect((decs?.[0] as unknown[] ?? []).length).toBe(1);   // 曾漏 decisions:图模型下天然覆盖
    expect((qus?.[0] as unknown[] ?? []).length).toBe(1);
  });

  it("derived_from 带 provenance 指向 turn;part_of 连 turn→session", async () => {
    const repo = await makeMem();
    const base = repo.getState();
    repo.replaceState({ ...base,
      sessions: [makeSession("se_1", [{ id: "tu_1", role: "user" as const, content: "原话", intent: "", timestamp: "2026-06-27T00:00:00.000Z" }])],
      points: [{ id: "pt_1", title: "t", content: "c", status: "稳定观点" as const, confidence: "用户确认" as const, evidence: [], relatedThemeIds: [], important: false, updatedAt: "2026-06-27T00:00:00.000Z", evidenceAnchors: [{ sessionId: "se_1", turnId: "tu_1" }] }]
    });
    await repo.flush();
    const [prov] = await repo.query<[Array<{ provenance: { origin: string } }>]>("SELECT provenance FROM derived_from;");
    expect(prov?.[0]?.provenance?.origin).toBe("user_confirmed"); // ⑤:pt_1 confidence='用户确认' → user_confirmed
    const [src] = await repo.query<[unknown[]]>("SELECT VALUE ->derived_from->turn FROM point:pt_1;");
    expect((src?.[0] as unknown[] ?? []).length).toBe(1);
    const [parent] = await repo.query<[unknown[]]>("SELECT VALUE ->part_of->session FROM turn:tu_1;");
    expect((parent?.[0] as unknown[] ?? []).length).toBe(1);
  });

  it("边全量覆盖:删掉关联后重写,旧边不残留", async () => {
    const repo = await makeMem();
    const base = repo.getState();
    const theme = { id: "th_1", name: "x", summary: "", maturity: "聚焦" as const, representativeQuote: "", appearances: 1, nextQuestion: "", updatedAt: "2026-06-27T00:00:00.000Z" };
    repo.replaceState({ ...base, themes: [theme], points: [{ id: "pt_1", title: "t", content: "c", status: "稳定观点" as const, confidence: "用户确认" as const, evidence: [], relatedThemeIds: ["th_1"], important: false, updatedAt: "2026-06-27T00:00:00.000Z" }] });
    await repo.flush();
    // 去掉 relatedThemeIds 再写
    repo.replaceState({ ...repo.getState(), points: [{ ...repo.getState().points[0], relatedThemeIds: [] }] });
    await repo.flush();
    const [bt] = await repo.query<[unknown[]]>("SELECT * FROM belongs_to_theme;");
    expect((bt ?? []).length).toBe(0);   // 全量覆盖:旧边已清
  });

  it("连续两次 replaceState(diff 增量)后内存与 flush 后一致,无漏写", async () => {
    const repo = await makeMem();
    const base = repo.getState();
    repo.replaceState({ ...base, points: [{ id:"pt_1", title:"一", content:"c", status:"稳定观点" as const, confidence:"用户确认" as const, evidence:[], relatedThemeIds:[], important:false, updatedAt:"2026-06-27T00:00:00.000Z" }] });
    repo.replaceState({ ...repo.getState(), points: [...repo.getState().points, { id:"pt_2", title:"二", content:"c", status:"稳定观点" as const, confidence:"用户确认" as const, evidence:[], relatedThemeIds:[], important:false, updatedAt:"2026-06-27T00:00:00.000Z" }] });
    await repo.flush();
    // 直查底层:两次 diff 增量写后两条都在(无丢行)。
    // 注:本用例只证"无丢行";基线确实推进(diff 相对上次成功态而非空)由下面多步 reload 用例的
    //     "删 pt_2 后 reload 应 gone"覆盖——基线不推进则 removeIds 算不出 pt_2、删不掉,该断言会红。
    const [rows] = await repo.query<[Array<{ id: unknown }>]>("SELECT id FROM point;");
    expect((rows ?? []).length).toBe(2);
  });

  // 轻量推理(欠账②):contradicts 边投影 mem:// 往返。symmetric 去重 → DB 里只一条边,
  // 连两端 point;清空软链后边不残留(全量覆盖)。
  it("contradicts 边:双向软链 symmetric 去重投影成一条 point↔point 边,清空后不残留", async () => {
    const repo = await makeMem();
    const base = repo.getState();
    repo.replaceState({ ...base,
      points: [
        { id: "pt_a", title: "集权", content: "c", status: "被挑战中" as const, confidence: "AI 推断" as const, evidence: [], relatedThemeIds: [], important: false, updatedAt: "2026-06-27T00:00:00.000Z", contradictsPointIds: ["pt_b"] },
        { id: "pt_b", title: "放权", content: "c", status: "稳定观点" as const, confidence: "用户确认" as const, evidence: [], relatedThemeIds: [], important: false, updatedAt: "2026-06-27T00:00:00.000Z", contradictsPointIds: ["pt_a"] }
      ]
    });
    await repo.flush();
    // 双向软链 → symmetric 去重 → 整库恰一条 contradicts 边。
    const [all] = await repo.query<[unknown[]]>("SELECT * FROM contradicts;");
    expect((all ?? []).length).toBe(1);
    // 该边从 pt_a(字典序在前)出、指向 pt_b。
    const [out] = await repo.query<[unknown[]]>("SELECT VALUE ->contradicts->point FROM point:pt_a;");
    expect((out?.[0] as unknown[] ?? []).length).toBe(1);
    // 清空 contradictsPointIds 重写 → 边被全量覆盖清掉。
    repo.replaceState({ ...repo.getState(), points: repo.getState().points.map((p) => ({ ...p, contradictsPointIds: [] })) });
    await repo.flush();
    const [after] = await repo.query<[unknown[]]>("SELECT * FROM contradicts;");
    expect((after ?? []).length).toBe(0);
  });

  // ⑥ 取代关系(欠账②):supersededByPointId → evolves_into 边 mem:// 往返(验证 ENFORCED point→point + diff)。
  it("evolves_into 边:supersededByPointId 投影成 point→point 边,清空后不残留", async () => {
    const repo = await makeMem();
    const base = repo.getState();
    repo.replaceState({ ...base,
      points: [
        { id: "pt_old", title: "旧", content: "c", status: "已修正" as const, confidence: "AI 推断" as const, evidence: [], relatedThemeIds: [], important: false, updatedAt: "2026-06-27T00:00:00.000Z", supersededByPointId: "pt_new" },
        { id: "pt_new", title: "新", content: "c", status: "稳定观点" as const, confidence: "用户确认" as const, evidence: [], relatedThemeIds: [], important: false, updatedAt: "2026-06-27T00:00:00.000Z" }
      ]
    });
    await repo.flush();
    const [all] = await repo.query<[unknown[]]>("SELECT * FROM evolves_into;");
    expect((all ?? []).length).toBe(1);                          // ENFORCED point→point RELATE 成功
    const [out] = await repo.query<[unknown[]]>("SELECT VALUE ->evolves_into->point FROM point:pt_old;");
    expect((out?.[0] as unknown[] ?? []).length).toBe(1);        // pt_old →evolves_into→ pt_new
    repo.replaceState({ ...repo.getState(), points: repo.getState().points.map((p) => ({ ...p, supersededByPointId: undefined })) });
    await repo.flush();
    const [gone] = await repo.query<[unknown[]]>("SELECT * FROM evolves_into;");
    expect((gone ?? []).length).toBe(0);                         // 清空 supersededByPointId → 边全量覆盖清掉
  });
});

describe("surreal diff-upsert (surrealkv://)", () => {
  it("多步增量写(增/改/删 节点+边)后跨进程 reload,DB 态与最终 state 等价", () => {
    const dir = mkdtempSync(join(tmpdir(), "surreal-p1c-"));
    try {
      const url = `surrealkv://${dir}/surreal`;
      const repoSrc = JSON.stringify(join(process.cwd(), "packages/db/src/surreal/surreal-product-state-repository.ts"));
      // 写进程:连续多次 replaceState(增 theme+point+边 → 改 point → 删 point),每次 flush。
      const w = runScript(`
import { createSurrealProductStateRepository } from ${repoSrc};
const repo = await createSurrealProductStateRepository({ url: ${JSON.stringify(url)} });
const base = repo.getState();
const theme = { id:'th_1', name:'放权', summary:'', maturity:'聚焦', representativeQuote:'', appearances:1, nextQuestion:'', updatedAt:'2026-06-27T00:00:00.000Z' };
repo.replaceState({ ...base, themes:[theme],
  points:[{ id:'pt_1', title:'A', content:'c', status:'稳定观点', confidence:'用户确认', evidence:[], relatedThemeIds:['th_1'], important:false, updatedAt:'2026-06-27T00:00:00.000Z' },
           { id:'pt_2', title:'B', content:'c', status:'稳定观点', confidence:'用户确认', evidence:[], relatedThemeIds:['th_1'], important:false, updatedAt:'2026-06-27T00:00:00.000Z' }] });
await repo.flush();
let s = repo.getState();
repo.replaceState({ ...s, points: s.points.map(p => p.id==='pt_1' ? { ...p, title:'A改' } : p) });
await repo.flush();
s = repo.getState();
repo.replaceState({ ...s, points: s.points.filter(p => p.id!=='pt_2') });
await repo.flush();
await repo.close();
console.log('ok'); process.exit(0);
`, join(dir, "w.mts"));
      if (w.status !== 0) throw new Error("写进程失败:\n" + w.stderr);
      // 读进程:reload,断言最终态(pt_1 改名、pt_2 没了、pt_2 的边没了、pt_1 的边在)。
      const r = runScript(`
import { createSurrealProductStateRepository } from ${repoSrc};
const repo = await createSurrealProductStateRepository({ url: ${JSON.stringify(url)} });
const s = repo.getState();
const [bt] = await repo.query("SELECT VALUE <-belongs_to_theme<-point FROM theme:th_1;");
console.log(JSON.stringify({
  pt1: s.points.find(p=>p.id==='pt_1')?.title,
  pt2: s.points.find(p=>p.id==='pt_2') ? 'present' : 'gone',
  btCount: (bt?.[0] ?? []).length
}));
await repo.close(); process.exit(0);
`, join(dir, "r.mts"));
      if (r.status !== 0) throw new Error("读进程失败:\n" + r.stderr);
      const out = JSON.parse(r.stdout.trim().split("\n").filter(l=>l.startsWith("{")).at(-1) ?? "{}") as { pt1?: string; pt2?: string; btCount?: number };
      expect(out.pt1).toBe("A改");        // 改生效
      expect(out.pt2).toBe("gone");        // 删生效
      expect(out.btCount).toBe(1);          // 仅 pt_1 的边在(pt_2 删除连带其边被 diffEdges 移除)
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 60000);
});

describe("surreal H1: 降冷剥 turns 后溯源仍可召回 (surrealkv://)", () => {
  it("先写 turns+资产锚点 → 再写 turns 剥空(资产留)→ reload:turn 节点 + derived_from/part_of 仍在,recallProvenanceTurns 能召回", () => {
    const dir = mkdtempSync(join(tmpdir(), "surreal-h1-"));
    try {
      const url = `surrealkv://${dir}/surreal`;
      const repoSrc = JSON.stringify(join(process.cwd(), "packages/db/src/surreal/surreal-product-state-repository.ts"));
      // 写进程:① persist 含 turn + point(带 evidenceAnchors→derived_from)→ ② 模拟降冷:
      //         同一 session 的 turns 剥空(资产保留),再 persist。turn append-only 应保住节点+边。
      const w = runScript(`
import { createSurrealProductStateRepository } from ${repoSrc};
const repo = await createSurrealProductStateRepository({ url: ${JSON.stringify(url)} });
const base = repo.getState();
const session = { id:'se_1', title:'会话', mode:'daily', strength:'standard', status:'active',
  startedAt:'2026-06-27T00:00:00.000Z', card:{}, guide:{},
  turns:[{ id:'tu_1', role:'user', content:'原话', intent:'', timestamp:'2026-06-27T00:00:00.000Z' }] };
const point = { id:'pt_1', title:'观点', content:'c', status:'稳定观点', confidence:'用户确认',
  evidence:[], relatedThemeIds:[], important:false, updatedAt:'2026-06-27T00:00:00.000Z',
  evidenceAnchors:[{ sessionId:'se_1', turnId:'tu_1' }] };
repo.replaceState({ ...base, sessions:[session], points:[point] });
await repo.flush();
// ── 降冷:剥掉该 session 的 turns(资产 pt_1 + 其 evidenceAnchors 保留) ──
const hot = repo.getState();
repo.replaceState({ ...hot, sessions: hot.sessions.map(s => s.id==='se_1' ? { ...s, turns:[], rawMaterialOffloaded:true } : s) });
await repo.flush();
await repo.close();
console.log('ok'); process.exit(0);
`, join(dir, "w.mts"));
      if (w.status !== 0) throw new Error("写进程失败:\n" + w.stderr);
      // 读进程:reload(内存 turns 已空),直查底层确认 turn 节点 + 两类边仍在,并走 recallProvenanceTurns。
      const r = runScript(`
import { createSurrealProductStateRepository } from ${repoSrc};
const repo = await createSurrealProductStateRepository({ url: ${JSON.stringify(url)} });
const [turnRows] = await repo.query("SELECT id FROM turn;");
const [dfRows] = await repo.query("SELECT VALUE ->derived_from->turn FROM point:pt_1;");
const [poRows] = await repo.query("SELECT VALUE ->part_of->session FROM turn:tu_1;");
const prov = await repo.recallProvenanceTurns("point", "pt_1");
console.log(JSON.stringify({
  turnCount: (turnRows ?? []).length,
  dfCount: (dfRows?.[0] ?? []).length,
  poCount: (poRows?.[0] ?? []).length,
  provIds: prov.map(t => t.id),
  provContent: prov[0]?.content ?? null
}));
await repo.close(); process.exit(0);
`, join(dir, "r.mts"));
      if (r.status !== 0) throw new Error("读进程失败:\n" + r.stderr);
      const out = JSON.parse(r.stdout.trim().split("\n").filter(l=>l.startsWith("{")).at(-1) ?? "{}") as
        { turnCount?: number; dfCount?: number; poCount?: number; provIds?: string[]; provContent?: string | null };
      expect(out.turnCount, "turn 节点 append-only 保留").toBe(1);
      expect(out.dfCount, "derived_from 边降冷后仍在").toBe(1);
      expect(out.poCount, "part_of 边降冷后仍在(跳 DELETE)").toBe(1);
      expect(out.provIds, "溯源召回到证据 turn").toContain("tu_1");
      expect(out.provContent, "证据 turn 内容无损").toBe("原话");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 60000);
});

describe("surreal A5: 删 session → DB 级联清子记录 + 边,跨进程 reload 无孤儿 (surrealkv://)", () => {
  it("写 session(turn/note)+point(锚点) → 删 session → reload:turn/note/part_of/derived_from 全清,point 留", () => {
    const dir = mkdtempSync(join(tmpdir(), "surreal-a5-"));
    try {
      const url = `surrealkv://${dir}/surreal`;
      const repoSrc = JSON.stringify(join(process.cwd(), "packages/db/src/surreal/surreal-product-state-repository.ts"));
      // 写进程:① persist 含 session(带 turn)+ note(sessionId=se_1)+ point(evidenceAnchors→derived_from)。
      //         ② 真正删除 session(从 state 移除)→ persist 发 `DELETE session WHERE id IN $del`,
      //            触发 005 EVENT 级联清 turn/note;turn 节点删除又令 part_of/derived_from 边原生消失。
      //            注:point 不归属 session,应保留(其 derived_from 指向已删 turn 的边随端点消失,无孤儿)。
      const w = runScript(`
import { createSurrealProductStateRepository } from ${repoSrc};
const repo = await createSurrealProductStateRepository({ url: ${JSON.stringify(url)} });
const base = repo.getState();
const session = { id:'se_1', title:'会话', mode:'daily', strength:'standard', status:'completed',
  startedAt:'2026-06-27T00:00:00.000Z', card:{}, guide:{},
  turns:[{ id:'tu_1', role:'user', content:'原话', intent:'', timestamp:'2026-06-27T00:00:00.000Z' }] };
const note = { id:'no_1', sessionId:'se_1', title:'笔记', summary:'s', keyQuote:'', saidTrack:[], learnedTrack:[], nextQuestions:[], createdAt:'2026-06-27T00:00:00.000Z' };
const point = { id:'pt_1', title:'观点', content:'c', status:'稳定观点', confidence:'用户确认',
  evidence:[], relatedThemeIds:[], important:false, updatedAt:'2026-06-27T00:00:00.000Z',
  evidenceAnchors:[{ sessionId:'se_1', turnId:'tu_1' }] };
repo.replaceState({ ...base, sessions:[session], notes:[note], points:[point] });
await repo.flush();
// ── 真删 session(purge):从 state 移除 → diff 算入 removeIds → DELETE session → EVENT 级联 ──
const hot = repo.getState();
repo.replaceState({ ...hot, sessions: hot.sessions.filter(s => s.id !== 'se_1') });
await repo.flush();
await repo.close();
console.log('ok'); process.exit(0);
`, join(dir, "w.mts"));
      if (w.status !== 0) throw new Error("写进程失败:\n" + w.stderr);
      // 读进程:reload,直查底层确认无孤儿(turn/note/两类边全 0),point 仍在。
      const r = runScript(`
import { createSurrealProductStateRepository } from ${repoSrc};
const repo = await createSurrealProductStateRepository({ url: ${JSON.stringify(url)} });
const [sessions] = await repo.query("SELECT id FROM session;");
const [turns] = await repo.query("SELECT id FROM turn;");
const [notes] = await repo.query("SELECT id FROM note;");
const [partOf] = await repo.query("SELECT id FROM part_of;");
const [derived] = await repo.query("SELECT id FROM derived_from;");
const [points] = await repo.query("SELECT id FROM point;");
console.log(JSON.stringify({
  sessionCount: (sessions ?? []).length,
  turnCount: (turns ?? []).length,
  noteCount: (notes ?? []).length,
  partOfCount: (partOf ?? []).length,
  derivedCount: (derived ?? []).length,
  pointCount: (points ?? []).length
}));
await repo.close(); process.exit(0);
`, join(dir, "r.mts"));
      if (r.status !== 0) throw new Error("读进程失败:\n" + r.stderr);
      const out = JSON.parse(r.stdout.trim().split("\n").filter(l=>l.startsWith("{")).at(-1) ?? "{}") as
        { sessionCount?: number; turnCount?: number; noteCount?: number; partOfCount?: number; derivedCount?: number; pointCount?: number };
      expect(out.sessionCount, "session 已删").toBe(0);
      expect(out.turnCount, "turn 被 EVENT 级联清(无孤儿)").toBe(0);
      expect(out.noteCount, "006 级联收缩:note 生命周期归域层,不随 session 级联删").toBe(1);
      expect(out.partOfCount, "part_of 边随 turn 节点删除自动消失").toBe(0);
      expect(out.derivedCount, "derived_from 边随 turn 节点删除自动消失(无孤儿边)").toBe(0);
      expect(out.pointCount, "point 不归属 session,保留").toBe(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 60000);
});
