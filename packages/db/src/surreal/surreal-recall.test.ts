import { describe, it, expect, afterEach } from "vitest";
import { createInitialProductState } from "../../../../src/domain/engine";
import { createSurrealProductStateRepository, type SurrealRepoHandle } from "./surreal-product-state-repository";
import { EMBEDDING_DIMENSION } from "./constants";

const open: SurrealRepoHandle[] = [];
afterEach(async () => { for (const r of open) await r.close(); open.length = 0; });
async function makeMem(): Promise<SurrealRepoHandle> {
  const r = await createSurrealProductStateRepository({ url: "mem://" }); open.push(r); return r;
}

function linkedState() {
  const base = createInitialProductState();
  return { ...base,
    themes: [{ id: "th_1", name: "放权", summary: "", maturity: "聚焦" as const, representativeQuote: "", appearances: 1, nextQuestion: "", updatedAt: "2026-06-27T00:00:00.000Z" }],
    sessions: [{ id: "se_1", mode: "daily", strength: "standard", status: "active", title: "会话", startedAt: "2026-06-27T00:00:00.000Z", turns: [{ id: "tu_1", role: "user", content: "原话", intent: "", timestamp: "2026-06-27T00:00:00.000Z" }] } as unknown as (typeof base.sessions)[number]],
    points: [{ id: "pt_1", title: "观点", content: "c", status: "稳定观点" as const, confidence: "用户确认" as const, evidence: [], relatedThemeIds: ["th_1"], important: false, updatedAt: "2026-06-27T00:00:00.000Z", evidenceAnchors: [{ sessionId: "se_1", turnId: "tu_1" }] }],
    decisions: [{ id: "de_1", title: "决策", decisionKind: "用户决策" as const, confirmationStatus: "用户确认" as const, choice: "c", tradeOff: "", riskHypothesis: "", reviewAt: "", status: "待复盘" as const, updatedAt: "2026-06-27T00:00:00.000Z", relatedThemeIds: ["th_1"] }],
    questions: [{ id: "qu_1", question: "q", whyImportant: "", status: "开放" as const, appearances: 1, relatedThemeIds: ["th_1"], nextPrompt: "", important: false, updatedAt: "2026-06-27T00:00:00.000Z" }],
    memoryRecords: [{ id: "me_1", text: "记忆", status: "confirmed" as const, sourceType: "profile" as const, sourceId: "p", evidenceQuote: "", sensitivity: "normal" as const, createdAt: "2026-06-27T00:00:00.000Z", updatedAt: "2026-06-27T00:00:00.000Z" }],
    memoryEdges: [{ fromMemoryRecordId: "me_1", themeId: "th_1" }]
  };
}

describe("surreal native recall: 图遍历", () => {
  it("recallThemeAssets:一次拿全 point+decision+question+memory(含曾漏 decisions)", async () => {
    const repo = await makeMem();
    repo.replaceState(linkedState());
    await repo.flush();
    const r = await repo.recallThemeAssets("th_1");
    expect(r.points).toContain("pt_1");
    expect(r.decisions).toContain("de_1");   // 曾漏 decisions:图模型下天然覆盖
    expect(r.questions).toContain("qu_1");
    expect(r.memories).toContain("me_1");     // about_theme
  });

  it("recallProvenanceTurns:沿 derived_from 取证据 turn", async () => {
    const repo = await makeMem();
    repo.replaceState(linkedState());
    await repo.flush();
    const turns = await repo.recallProvenanceTurns("point", "pt_1");
    expect(turns.map((t) => t.id)).toContain("tu_1");
    expect(turns[0]?.content).toBe("原话");
  });
});

function memWithEmbedding(id: string, text: string, vec: number[], opts: { sensitivity?: "normal" | "sensitive"; status?: "confirmed" | "deprecated" } = {}) {
  return { id, text, status: opts.status ?? "confirmed", sourceType: "profile" as const, sourceId: "p",
    evidenceQuote: "", sensitivity: opts.sensitivity ?? "normal", embedding: vec,
    createdAt: "2026-06-27T00:00:00.000Z", updatedAt: "2026-06-27T00:00:00.000Z" };
}
// 造 DIMENSION 维向量:第 0 位置不同以区分方向。
function vec(seed: number): number[] { const v = new Array(EMBEDDING_DIMENSION).fill(0); v[0] = seed; v[1] = 1; return v; }

describe("surreal native recall: 向量 HNSW + A4 门控", () => {
  it("recallMemoriesByVector:返回余弦最近的 confirmed/normal 记忆", async () => {
    const repo = await makeMem();
    const base = createInitialProductState();
    repo.replaceState({ ...base, memoryRecords: [
      memWithEmbedding("me_near", "近", vec(1)),
      memWithEmbedding("me_far", "远", vec(-1))
    ] });
    await repo.flush();
    const hits = await repo.recallMemoriesByVector(vec(1), 1);
    expect(hits.map((h) => h.id)).toEqual(["me_near"]);
  });

  it("A4 门控:默认不返回 sensitive / 非 confirmed;includeSensitive 才含 sensitive", async () => {
    const repo = await makeMem();
    const base = createInitialProductState();
    repo.replaceState({ ...base, memoryRecords: [
      memWithEmbedding("me_norm", "普通", vec(1)),
      memWithEmbedding("me_sens", "敏感", vec(1), { sensitivity: "sensitive" }),
      memWithEmbedding("me_dep", "弃用", vec(1), { status: "deprecated" })
    ] });
    await repo.flush();
    const def = await repo.recallMemoriesByVector(vec(1), 10);
    expect(def.map((h) => h.id).sort()).toEqual(["me_norm"]);           // 仅 confirmed+normal
    const withSens = await repo.recallMemoriesByVector(vec(1), 10, { includeSensitive: true });
    expect(withSens.map((h) => h.id).sort()).toEqual(["me_norm", "me_sens"]); // 含 sensitive,仍不含 deprecated
  });
});
