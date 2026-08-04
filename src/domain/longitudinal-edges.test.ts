import { describe, expect, it } from "vitest";
import {
  buildInterviewContextPack,
  buildInterviewGuide,
  createSessionDraft,
  decideInterviewStrategy,
  createInitialProductState
} from "./engine";
import { buildOpinionEvolution, buildPointContradictions } from "./context-pack";
import { resolveMemoryConflict } from "./memory-consolidation";
import { applyCognitiveRelations } from "./reasoning";
import type { MemoryRecord, PointAsset } from "./types";

const now = "2026-08-01T12:00:00.000Z";

function point(id: string, title: string, content: string, extra: Partial<PointAsset> = {}): PointAsset {
  return {
    id,
    title,
    content,
    status: "稳定观点",
    confidence: "AI 推断",
    evidence: ["e"],
    relatedThemeIds: ["th1"],
    important: false,
    updatedAt: now,
    ...extra
  };
}

describe("longitudinal edges — produce + consume (shipped domain paths)", () => {
  it("applyCognitiveRelations writes contradicts soft-links consumed by guide + strategy", () => {
    let state = createInitialProductState();
    state = {
      ...state,
      themes: [
        {
          id: "th1",
          name: "授权",
          summary: "授权主题",
          maturity: "聚焦",
          representativeQuote: "拍板",
          appearances: 2,
          nextQuestion: "谁决定？",
          updatedAt: now
        }
      ],
      points: [
        point("pt_a", "集权", "关键节点必须我亲自拍板", { confidence: "用户确认" }),
        point("pt_b", "放权", "关键节点应该交给一线")
      ]
    };

    state = applyCognitiveRelations(state, {
      contradicts: [["pt_a", "pt_b"]],
      supersedes: []
    });

    const pa = state.points.find((p) => p.id === "pt_a")!;
    const pb = state.points.find((p) => p.id === "pt_b")!;
    expect(pa.contradictsPointIds).toContain("pt_b");
    expect(pb.contradictsPointIds).toContain("pt_a");

    const pairs = buildPointContradictions(state);
    expect(pairs.some((p) => (p.a === "集权" && p.b === "放权") || (p.a === "放权" && p.b === "集权"))).toBe(
      true
    );

    const guide = buildInterviewGuide(state, { topicHint: "授权拍板" });
    expect(guide.strategyChecklist.some((line) => line.includes("对立看法"))).toBe(true);

    const session = createSessionDraft(state, "daily", "standard", { topicHint: "授权拍板" });
    session.turns = Array.from({ length: 8 }, (_, i) => ({
      id: `t${i}`,
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: `内容${i}`,
      intent: i % 2 === 0 ? "用户表达" : "追问",
      timestamp: now
    }));
    session.guide = guide;
    session.strategyTrace = [];
    const decision = decideInterviewStrategy(session, "我还是想自己拍板");
    expect(decision.strategy).toBe("contradiction_review");
  });

  it("supersedes writes evolves_into soft-link and opinion evolution; old point excluded from stated positions", () => {
    let state = createInitialProductState();
    state = {
      ...state,
      themes: [
        {
          id: "th1",
          name: "授权",
          summary: "授权主题",
          maturity: "聚焦",
          representativeQuote: "拍板",
          appearances: 2,
          nextQuestion: "谁决定？",
          updatedAt: now
        }
      ],
      points: [
        point("pt_old", "旧判断", "必须亲自拍板每一个细节", {
          status: "稳定观点",
          confidence: "AI 推断",
          updatedAt: "2026-01-01T00:00:00.000Z"
        }),
        point("pt_new", "新判断", "先试点再放权", {
          status: "稳定观点",
          confidence: "用户确认",
          updatedAt: now
        })
      ]
    };

    state = applyCognitiveRelations(state, {
      contradicts: [],
      supersedes: [{ oldId: "pt_old", newId: "pt_new" }]
    });

    const oldP = state.points.find((p) => p.id === "pt_old")!;
    expect(oldP.supersededByPointId).toBe("pt_new");
    expect(oldP.status).toBe("已修正");

    const evolution = buildOpinionEvolution(state);
    expect(evolution.length).toBeGreaterThan(0);
    expect(evolution[0]!.oldView).toContain("亲自拍板");
    expect(evolution[0]!.newView).toContain("试点");

    const guide = buildInterviewGuide(state, { topicHint: "授权" });
    // 已修正 points must not appear as current stated positions
    expect(guide.statedPositions.every((line) => !line.includes("必须亲自拍板每一个细节"))).toBe(true);
  });

  it("resolveMemoryConflict demotes loser; demoted memory not packed as confirmed", () => {
    const keep: MemoryRecord = {
      id: "m_keep",
      text: "放权时我应该先试点再扩大",
      status: "confirmed",
      sourceType: "interview_session",
      sourceId: "s1",
      evidenceQuote: "证据足够长作为引用锚点一",
      sensitivity: "normal",
      createdAt: now,
      updatedAt: now,
      importance: 9
    };
    const demote: MemoryRecord = {
      id: "m_demote",
      text: "放权时我不应该试点直接全量",
      status: "confirmed",
      sourceType: "interview_session",
      sourceId: "s1",
      evidenceQuote: "证据足够长作为引用锚点二",
      sensitivity: "normal",
      createdAt: now,
      updatedAt: now,
      importance: 7
    };
    let state = {
      ...createInitialProductState(),
      memoryRecords: [keep, demote]
    };
    state = resolveMemoryConflict(state, {
      keepRecordId: "m_keep",
      demoteRecordId: "m_demote",
      now
    });
    const demoted = state.memoryRecords.find((r) => r.id === "m_demote")!;
    expect(demoted.status).toBe("deprecated");
    expect(demoted.supersededByRecordId).toBe("m_keep");
    expect(state.memoryRecords.find((r) => r.id === "m_keep")!.supersedesRecordIds).toContain("m_demote");
    expect(state.memoryRecords.find((r) => r.id === "m_keep")!.contradictsRecordIds).toContain("m_demote");

    state.systemConfig = {
      ...state.systemConfig,
      memory: { ...state.systemConfig.memory, includePendingCandidatesInContext: false }
    };
    const pack = buildInterviewContextPack(state, { topicHint: "放权试点" });
    const ids = pack.memoryRecords.map((r) => r.id);
    expect(ids).toContain("m_keep");
    expect(ids).not.toContain("m_demote");
  });
});
