import { describe, expect, it } from "vitest";
import { buildInterviewCard, buildInterviewGuide, buildSemanticRagContext } from "./context-pack";
import { createInitialProductState } from "./engine";
import type { RagChunk, ImportSource } from "./types";

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeImportSource(id: string): ImportSource {
  return {
    id,
    title: `Source ${id}`,
    sourceType: "text",
    content: "test content",
    status: "chunked",
    sensitivity: "normal",
    chunkIds: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

function makeRagChunk(id: string, sourceId: string, text: string, embedding?: number[]): RagChunk {
  return {
    id,
    sourceId,
    title: `Chunk ${id}`,
    text,
    keywords: [],
    tokenEstimate: Math.ceil(text.length / 2),
    usage: "interview-context",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...(embedding !== undefined ? { embedding } : {})
  };
}

// ─── cosine retrieval tests ───────────────────────────────────────────────────

describe("buildSemanticRagContext — cosine retrieval", () => {
  it("ranks chunks by cosine similarity when query embedding provided", () => {
    const state = createInitialProductState();
    const source = makeImportSource("src-1");
    state.importSources = [source];

    // Three chunks with different embeddings; queryVec = [1,0,0]
    // chunkA: [1,0,0] → cosine=1 (most similar)
    // chunkB: [0,1,0] → cosine=0
    // chunkC: [0.7,0.7,0] → cosine≈0.707
    const chunkA = makeRagChunk("c-a", "src-1", "团队授权和直接下场", [1, 0, 0]);
    const chunkB = makeRagChunk("c-b", "src-1", "情感与沟通", [0, 1, 0]);
    const chunkC = makeRagChunk("c-c", "src-1", "管理风格与判断", [0.7, 0.7, 0]);
    state.ragChunks = [chunkA, chunkB, chunkC];

    const queryEmbedding = [1, 0, 0];
    const result = buildSemanticRagContext(state, "授权", 5, queryEmbedding);

    expect(result.chunks.length).toBeGreaterThan(0);
    // chunkA should rank first (cosine=1), chunkC second (cosine≈0.707)
    expect(result.chunks[0].id).toBe("c-a");
    if (result.chunks.length > 1) {
      expect(result.chunks[1].id).toBe("c-c");
    }
  });

  it("falls back to keyword scoring when no queryEmbedding provided", () => {
    const state = createInitialProductState();
    const source = makeImportSource("src-2");
    state.importSources = [source];

    // chunkX has the keyword "授权" (matches the topicHint), chunkY does not
    const chunkX = makeRagChunk("c-x", "src-2", "团队授权下场机制分析授权边界授权决策", [0, 0, 1]);
    const chunkY = makeRagChunk("c-y", "src-2", "完全不相关的段落 abc xyz", [1, 0, 0]);
    state.ragChunks = [chunkX, chunkY];

    // No queryEmbedding → should use keyword path
    const result = buildSemanticRagContext(state, "授权", 5);

    // chunkX should be returned via keyword match; chunkY should not score high enough
    expect(result.chunks.some((c) => c.id === "c-x")).toBe(true);
  });

  it("falls back to keyword scoring when chunks have no embeddings even if queryEmbedding is given", () => {
    const state = createInitialProductState();
    const source = makeImportSource("src-3");
    state.importSources = [source];

    // Chunks WITHOUT embedding fields
    const chunkA = makeRagChunk("c-a3", "src-3", "授权团队决策", undefined);
    const chunkB = makeRagChunk("c-b3", "src-3", "授权机制边界", undefined);
    state.ragChunks = [chunkA, chunkB];

    // queryEmbedding provided but chunks lack embeddings → keyword fallback
    const result = buildSemanticRagContext(state, "授权", 5, [1, 0, 0]);
    // Should still return results via keyword path
    expect(result.chunks.length).toBeGreaterThan(0);
  });

  it("returns empty when state has no ragChunks", () => {
    const state = createInitialProductState();
    state.ragChunks = [];
    const result = buildSemanticRagContext(state, "授权", 5, [1, 0, 0]);
    expect(result.chunks).toHaveLength(0);
  });
});

// ─── original context-pack tests (must remain passing) ────────────────────────

describe("context-pack (de-hardcoded)", () => {
  it("does not parrot the 救火/控制感 demo when the user's themes are unrelated", () => {
    const state = createInitialProductState();
    state.themes = [{
      id: "t1", name: "搬家焦虑", summary: "关于搬到新城市的不安",
      maturity: "聚焦", representativeQuote: "我怕在新城市没有朋友",
      appearances: 3, nextQuestion: "你最担心失去什么？", updatedAt: new Date().toISOString()
    }];
    state.points = []; state.questions = []; state.debts = []; state.notes = [];
    const card = buildInterviewCard(state);
    expect(card.title).not.toContain("救火");
    expect(card.potentialTension).not.toContain("授权");
    expect(`${card.title} ${card.whyNow} ${card.suggestedOpening} ${card.potentialTension}`).toMatch(/搬家|新城市|朋友|焦虑/);
  });

  it("produces neutral card fields when the user has no themes (clean-start)", () => {
    const state = createInitialProductState();
    state.themes = []; state.points = []; state.questions = []; state.debts = []; state.notes = [];
    const card = buildInterviewCard(state);
    expect(card.title).toBe("今天想聊点什么？");
    expect(card.whyNow.length).toBeGreaterThan(0);
    expect(card.suggestedOpening.length).toBeGreaterThan(0);
    expect(card.potentialTension.length).toBeGreaterThan(0);
    expect(`${card.title}${card.whyNow}${card.potentialTension}`).not.toMatch(/救火|授权/);
  });

  it("blindspot candidates never leak the 救火/授权 demo persona", () => {
    for (const themes of [[], [{ id: "t1", name: "搬家焦虑", summary: "搬到新城市的不安", maturity: "聚焦" as const, representativeQuote: "怕没朋友", appearances: 2, nextQuestion: "最担心失去什么？", updatedAt: new Date().toISOString() }]]) {
      const state = createInitialProductState();
      state.themes = themes; state.points = []; state.questions = []; state.debts = []; state.notes = []; state.memoryRecords = []; state.memoryCandidates = [];
      const guide = buildInterviewGuide(state);
      for (const b of guide.blindspotCandidates) {
        expect(`${b.concept} ${b.reason}`).not.toMatch(/救火|授权/);
      }
    }
  });
});
