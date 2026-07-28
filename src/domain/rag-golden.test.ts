import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { KnowledgeChunk } from "./types";
import { scoreRagGoldenCase, summarizeRagGolden, type RagGoldenCase } from "./rag-golden";
import { decideGroundingMode, toCitationEnvelopes } from "./retrieval";
import {
  filterEchoChamberTexts,
  resolveMemoryConflict,
  buildConsolidationQueuePreview
} from "./memory-consolidation";
import { createInitialProductState } from "./engine";

const here = dirname(fileURLToPath(import.meta.url));
const goldenPath = join(here, "../../tests/fixtures/rag-golden/cases.json");

function chunk(
  sourceId: string,
  title: string,
  text: string,
  sourceType: KnowledgeChunk["sourceType"] = "memory"
): KnowledgeChunk {
  return {
    id: `chunk-${sourceId}`,
    sourceType,
    sourceId,
    title,
    text,
    keywords: [],
    createdAt: "2026-07-01T00:00:00.000Z"
  };
}

const corpus: KnowledgeChunk[] = [
  chunk("mem-goal", "长期目标", "我的长期职业目标是打造本地优先的认知产品"),
  chunk("mem-focus", "当前焦点", "当前工作焦点是专访式日记的记忆与召回质量"),
  chunk("mem-auth", "授权", "团队授权时我不应该亲自拍板每一个细节"),
  chunk("mem-role", "角色", "我是独立产品构建者，偏好深度访谈"),
  chunk("note-last", "近场专访", "上次专访总结了定价与招聘节奏的张力", "note"),
  chunk("debt-rag", "知识债", "开放知识债：还欠对混合召回评测的系统理解", "debt"),
  chunk("point-price", "定价观点", "关于定价策略：先证明价值再提价", "point"),
  chunk("dec-hire", "招聘决策", "待复盘决策：是否放缓招聘节奏", "decision"),
  chunk("q-scale", "规模化问题", "我反复问过如何规模化而不失去深度", "note"),
  chunk("theme-product", "产品主题", "长期主题：产品差异化与本地优先", "theme"),
  chunk("mat-competitor", "竞品材料", "导入材料里关于竞品的笔记：对方强在分发", "material"),
  chunk("tx-s1", "逐字稿", "最近一场访谈关键引用：用户强调诚实失败信号", "transcript")
];

describe("rag-golden", () => {
  it("scores ≥30 cases with solid hit@k and refuse rates", () => {
    const cases = JSON.parse(readFileSync(goldenPath, "utf8")) as RagGoldenCase[];
    expect(cases.length).toBeGreaterThanOrEqual(30);
    const scores = cases.map((c) => scoreRagGoldenCase(corpus, c));
    const summary = summarizeRagGolden(scores);
    expect(summary.hitAtKRate).toBeGreaterThanOrEqual(0.75);
    expect(summary.refuseCorrectRate).toBeGreaterThanOrEqual(0.85);
  });

  it("builds citation envelopes and grounding modes", () => {
    const envelopes = toCitationEnvelopes(corpus.slice(0, 2), [0.9, 0.5], "2026-07-28T00:00:00.000Z");
    expect(envelopes[0]!.sourceId).toBe("mem-goal");
    expect(envelopes[0]!.retrievedAt).toBeTruthy();
    expect(decideGroundingMode({ rejected: true, retrievedCount: 0, citationCount: 0 })).toBe("refused");
    expect(decideGroundingMode({ rejected: false, retrievedCount: 2, citationCount: 0 })).toBe("partial");
    expect(decideGroundingMode({ rejected: false, retrievedCount: 2, citationCount: 1 })).toBe("grounded");
  });
});

describe("memory lifecycle stage-3", () => {
  it("filters echo-chamber restatements", () => {
    const kept = filterEchoChamberTexts(
      ["团队授权时我不应该亲自拍板每一个细节", "全新的洞察：用户讨厌冗长开场"],
      ["团队授权时我不应该亲自拍板每一个细节"]
    );
    expect(kept).toEqual(["全新的洞察：用户讨厌冗长开场"]);
  });

  it("resolves conflict with supersede demote-not-delete", () => {
    let state = createInitialProductState();
    const a = {
      id: "m-a",
      text: "团队授权时我应该亲自拍板每一个细节",
      status: "confirmed" as const,
      sourceType: "interview_session" as const,
      sourceId: "s1",
      evidenceQuote: "",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      importance: 7
    };
    const b = {
      id: "m-b",
      text: "团队授权时我不应该亲自拍板每一个细节",
      status: "confirmed" as const,
      sourceType: "interview_session" as const,
      sourceId: "s1",
      evidenceQuote: "",
      createdAt: "2026-01-02T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
      importance: 8
    };
    state = { ...state, memoryRecords: [a, b] };
    const next = resolveMemoryConflict(state, { keepRecordId: "m-b", demoteRecordId: "m-a" });
    const keep = next.memoryRecords.find((r) => r.id === "m-b")!;
    const demoted = next.memoryRecords.find((r) => r.id === "m-a")!;
    expect(keep.supersedesRecordIds).toContain("m-a");
    expect(demoted.status).toBe("deprecated");
    expect(demoted.supersededByRecordId).toBe("m-b");
  });

  it("queue mode preview does not require LLM", () => {
    const state = createInitialProductState();
    const preview = buildConsolidationQueuePreview(state);
    expect(preview.decayPreview).toBeDefined();
    expect(Array.isArray(preview.contradictionCandidates)).toBe(true);
  });
});
