import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { runProductStateRepositoryContract } from "../repository-contract";
import { createSurrealProductStateRepository, type SurrealRepoHandle } from "./surreal-product-state-repository";
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

/**
 * Run a .mts script as a child process via tsx.
 * Returns { stdout, stderr, status }.
 * NOTE: @surrealdb/node HNSW native thread holds the surrealkv exclusive file lock
 * in the same process even after db.close(), so all surrealkv I/O in the durability
 * test must happen in separate child processes.
 */
function runScript(src: string, scriptPath: string): { stdout: string; stderr: string; status: number | null } {
  writeFileSync(scriptPath, src);
  const tsxBin = join(process.cwd(), "node_modules/.bin/tsx");
  const result = spawnSync(tsxBin, [scriptPath], { encoding: "utf8", timeout: 30000 });
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status };
}

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
console.log(JSON.stringify({ pt, th }));
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
      };
      expect(parsed.pt?.title, "point title persisted").toBe("持久化");
      expect(parsed.pt?.relatedThemeIds, "relatedThemeIds (rest) persisted").toEqual(["th_kv"]);
      expect(parsed.pt?.evidence, "evidence (rest) persisted").toEqual(["x"]);
      expect(parsed.th?.id, "theme persisted").toBe("th_kv");
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
    expect(prov?.[0]?.provenance?.origin).toBe("llm_extracted");
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
    // 直查底层:两条都在(第二次 diff 基线=第一次成功后,增量只含 pt_2,但 pt_1 仍在)
    const [rows] = await repo.query<[Array<{ id: unknown }>]>("SELECT id FROM point;");
    expect((rows ?? []).length).toBe(2);
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
