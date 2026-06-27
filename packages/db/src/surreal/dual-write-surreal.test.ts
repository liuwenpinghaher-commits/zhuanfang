import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInitialProductState } from "../../../../src/domain/engine";
import { createSqliteProductStateRepository } from "../sqlite-product-state-repository";
import { createSurrealProductStateRepository, type SurrealRepoHandle } from "./surreal-product-state-repository";
import { createDualWriteRepository } from "../../../../apps/api/src/dual-write-repository";

// 集成测试:sqlite 权威 + 真实 surreal(mem://) 影子,写真实内容,断言影子读不报发散。
// 把"controller 手工冒烟 diverged:false"变成可复跑 CI 证据;并守住 schemaVersion 忽略修复不回退。
// (放 packages/db:bundler 解析才能 import @surrealdb/node;apps/api 的 Node 解析会 TS2307。)

const tmpDirs: string[] = [];
const surreals: SurrealRepoHandle[] = [];
afterEach(async () => {
  for (const s of surreals) await s.close();
  surreals.length = 0;
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  tmpDirs.length = 0;
});

function realisticState() {
  const base = createInitialProductState();
  return {
    ...base,
    themes: [{ id: "th_1", name: "放权", summary: "组织设计", maturity: "聚焦" as const, representativeQuote: "", appearances: 2, nextQuestion: "", updatedAt: "2026-06-27T00:00:00.000Z" }],
    points: [{ id: "pt_1", title: "观点", content: "内容", status: "稳定观点" as const, confidence: "用户确认" as const, evidence: ["e1", "e2"], relatedThemeIds: ["th_1"], important: true, updatedAt: "2026-06-27T00:00:00.000Z", evidenceAnchors: [{ sessionId: "se_1", turnId: "tu_1" }] }],
    decisions: [{ id: "de_1", title: "决策", decisionKind: "用户决策" as const, confirmationStatus: "用户确认" as const, choice: "选 A", tradeOff: "", riskHypothesis: "", reviewAt: "", status: "待复盘" as const, updatedAt: "2026-06-27T00:00:00.000Z", relatedThemeIds: ["th_1"] }],
    questions: [{ id: "qu_1", question: "问题?", whyImportant: "重要", status: "开放" as const, appearances: 1, relatedThemeIds: ["th_1"], nextPrompt: "", important: false, updatedAt: "2026-06-27T00:00:00.000Z" }],
    memoryRecords: [{ id: "me_1", text: "记忆", status: "confirmed" as const, sourceType: "profile" as const, sourceId: "p", evidenceQuote: "原话", sensitivity: "normal" as const, createdAt: "2026-06-27T00:00:00.000Z", updatedAt: "2026-06-27T00:00:00.000Z" }]
  };
}

describe("dual-write: sqlite 权威 + 真实 surreal 影子", () => {
  it("写真实内容后影子读无发散(surreal getState 与 sqlite 内容等价)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dual-surreal-"));
    tmpDirs.push(dir);
    const sqlite = createSqliteProductStateRepository({ dbPath: join(dir, "product-state.db") });
    const surreal = await createSurrealProductStateRepository({ url: "mem://" });
    surreals.push(surreal);

    const onDivergence = vi.fn();
    const onShadowError = vi.fn();
    const repo = createDualWriteRepository({ authoritative: sqlite, shadow: surreal, onDivergence, onShadowError });

    repo.replaceState(realisticState());

    expect(onShadowError).not.toHaveBeenCalled();
    expect(onDivergence).not.toHaveBeenCalled();   // 业务内容两边等价(schemaVersion/revision 已被 contentDigest 忽略)
    // 读走权威(sqlite)且内容在
    expect(repo.getState().points.find((p) => p.id === "pt_1")?.relatedThemeIds).toEqual(["th_1"]);
  });
});
