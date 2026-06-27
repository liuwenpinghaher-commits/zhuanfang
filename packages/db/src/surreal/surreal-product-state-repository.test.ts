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
});
