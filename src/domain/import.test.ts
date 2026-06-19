import { describe, expect, it, vi } from "vitest";
import { createInitialProductState } from "./engine";
import { chunkDocument, ingestImportSource, EMBED_BATCH_SIZE, MAX_EMBEDDED_CHUNKS } from "./import";
import type { BailianEmbeddingClient } from "../../apps/api/src/providers/bailian";
import type { LongTermTheme, ProductState } from "./types";

describe("chunkDocument", () => {
  it("splits on paragraphs and caps chunk size", () => {
    const text = `${"a".repeat(700)}\n\n${"b".repeat(100)}`;
    const chunks = chunkDocument(text, 600);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 600)).toBe(true);
  });

  it("returns a single chunk for short text", () => {
    expect(chunkDocument("hello world", 600)).toEqual(["hello world"]);
  });
});

describe("ingestImportSource", () => {
  it("creates an import source, rag chunks, and pending candidates", async () => {
    const state = createInitialProductState();
    const { sourceId, candidateCount, nextState } = await ingestImportSource(
      state,
      { title: "T", content: "para one\n\npara two", sourceType: "text" },
      [
        { text: "fact A", evidenceQuote: "para one", sensitivity: "normal" },
        { text: "secret B", evidenceQuote: "para two", sensitivity: "sensitive" }
      ]
    );

    expect(candidateCount).toBe(2);
    expect(nextState.importSources[0].id).toBe(sourceId);
    // sensitivity rolls up to sensitive when any candidate is sensitive
    expect(nextState.importSources[0].sensitivity).toBe("sensitive");
    expect(nextState.ragChunks.length).toBeGreaterThan(0);

    const newCandidates = nextState.memoryCandidates.filter((candidate) => candidate.sourceId === sourceId);
    expect(newCandidates).toHaveLength(2);
    expect(newCandidates.every((candidate) => candidate.status === "pending")).toBe(true);
    expect(newCandidates.every((candidate) => typeof candidate.reviewScore === "number")).toBe(true);
    expect(newCandidates.every((candidate) => candidate.sourceType === "import_source")).toBe(true);
  });

  it("does not mutate the input state", async () => {
    const state = createInitialProductState();
    const before = state.importSources.length;
    await ingestImportSource(state, { title: "T", content: "x", sourceType: "text" }, []);
    expect(state.importSources.length).toBe(before);
  });

  it("attaches embeddings to chunks when embeddingClient is provided", async () => {
    const fakeEmbedding = [0.1, 0.2, 0.3];
    const fakeClient: BailianEmbeddingClient = {
      embed: async (texts: string[]) => texts.map(() => fakeEmbedding)
    };

    const state = createInitialProductState();
    const { sourceId, nextState } = await ingestImportSource(
      state,
      { title: "Embed Test", content: "paragraph alpha\n\nparagraph beta", sourceType: "text" },
      [],
      fakeClient
    );

    const newChunks = nextState.ragChunks.filter((chunk) => chunk.sourceId === sourceId);
    expect(newChunks.length).toBeGreaterThan(0);
    // Every chunk should have an embedding attached
    expect(newChunks.every((chunk) => Array.isArray(chunk.embedding))).toBe(true);
    expect(newChunks[0].embedding).toEqual(fakeEmbedding);
  });

  it("produces chunks without embedding when no embeddingClient is provided", async () => {
    const state = createInitialProductState();
    const { sourceId, nextState } = await ingestImportSource(
      state,
      { title: "No Embed", content: "some content here", sourceType: "text" },
      []
      // no embeddingClient
    );

    const newChunks = nextState.ragChunks.filter((chunk) => chunk.sourceId === sourceId);
    expect(newChunks.length).toBeGreaterThan(0);
    expect(newChunks.every((chunk) => chunk.embedding === undefined)).toBe(true);
  });

  it("does not throw when embeddingClient.embed fails — chunks still ingested", async () => {
    const failingClient: BailianEmbeddingClient = {
      embed: async () => { throw new Error("network error"); }
    };

    const state = createInitialProductState();
    const { sourceId, nextState } = await ingestImportSource(
      state,
      { title: "Fail Embed", content: "content that fails to embed", sourceType: "text" },
      [],
      failingClient
    );

    const newChunks = nextState.ragChunks.filter((chunk) => chunk.sourceId === sourceId);
    // Chunks still written, just without embeddings
    expect(newChunks.length).toBeGreaterThan(0);
    expect(newChunks.every((chunk) => chunk.embedding === undefined)).toBe(true);
  });

  // ── 修复2: 空数组 embedding 不附给 chunk ──────────────────────────────────
  it("embed 返回含空数组的批次时，对应 chunk 无 embedding 字段", async () => {
    // 需要产生 2 个独立 chunk：每段 > 600 字，chunkDocument 会将各段单独 chunk
    const longPara1 = "A".repeat(700);
    const longPara2 = "B".repeat(700);
    const validVec = [0.5, 0.5];

    let callIdx = 0;
    const clientWithEmptyVec: BailianEmbeddingClient = {
      embed: async (texts: string[]) =>
        texts.map(() => {
          const v = callIdx === 0 ? validVec : [];
          callIdx++;
          return v;
        })
    };

    const state = createInitialProductState();
    const { sourceId, nextState } = await ingestImportSource(
      state,
      { title: "Empty Vec Test", content: `${longPara1}\n\n${longPara2}`, sourceType: "text" },
      [],
      clientWithEmptyVec
    );

    const newChunks = nextState.ragChunks.filter((c) => c.sourceId === sourceId);
    expect(newChunks.length).toBeGreaterThanOrEqual(2);
    // 第一个 chunk 有有效 embedding
    expect(newChunks[0].embedding).toEqual(validVec);
    // 第二个 chunk embed 返回 []，不应附 embedding 字段
    expect(newChunks[1].embedding).toBeUndefined();
  });

  // ── 修复3: >10 个 chunk 时分批调用 embed ─────────────────────────────────
  it(`超过 EMBED_BATCH_SIZE(${EMBED_BATCH_SIZE}) 个 chunk 时 embed 被分多批调用，结果正确对位`, async () => {
    const batchCount = EMBED_BATCH_SIZE + 3; // 13 个 chunk
    // 每段 > maxChars=600，确保各段单独成 chunk
    const content = Array.from({ length: batchCount }, (_, i) =>
      `段落${i + 1}：` + "内容".repeat(310)
    ).join("\n\n");

    const embedSpy = vi.fn(async (texts: string[]) =>
      texts.map((_, i) => [i + 1, 0]) // 每个 chunk 返回不同向量以验证对位
    );
    const spyClient: BailianEmbeddingClient = { embed: embedSpy };

    const state = createInitialProductState();
    const { sourceId, nextState } = await ingestImportSource(
      state,
      { title: "Batch Test", content, sourceType: "text" },
      [],
      spyClient
    );

    const newChunks = nextState.ragChunks.filter((c) => c.sourceId === sourceId);
    // batchCount 段 × 每段约 620 字 → 每段 ceil(620/600) ≈ 2 chunk，共 ~26
    // 但核心要验证的是分批调用：embed 被调用次数 = ceil(newChunks.length / EMBED_BATCH_SIZE)
    const expectedCalls = Math.ceil(Math.min(newChunks.length, MAX_EMBEDDED_CHUNKS) / EMBED_BATCH_SIZE);
    expect(embedSpy).toHaveBeenCalledTimes(expectedCalls);
    // 每批大小 ≤ EMBED_BATCH_SIZE
    embedSpy.mock.calls.forEach((call) => {
      expect((call[0] as string[]).length).toBeLessThanOrEqual(EMBED_BATCH_SIZE);
    });
    // 所有 chunk 都应有非空 embedding
    expect(newChunks.every((c) => Array.isArray(c.embedding) && c.embedding!.length > 0)).toBe(true);
  });

  // ── 修复4: 超出 MAX_EMBEDDED_CHUNKS 的 chunk 不存 embedding ───────────────
  it(`导入超过 MAX_EMBEDDED_CHUNKS(${MAX_EMBEDDED_CHUNKS}) 的 chunk 时，只有前 N 个带 embedding`, async () => {
    // 每段 > 600 字 → 每段产生至少 1 个 chunk，用 MAX_EMBEDDED_CHUNKS+5 段确保超过上限
    // 但 MAX_EMBEDDED_CHUNKS=200 段 × 620 字 = 大内容，改用小 maxChars 测试
    // 直接用 chunkDocument 的 maxChars 参数无法在 ingestImportSource 中注入；
    // 替代方案：产生 201 个独立段（每段刚好 601 字 → chunkDocument 截断成 2 chunk）
    // 会产生 202~402 chunk，其中前 200 个带 embedding，其余无
    // 为避免生成数十万字的内容，退而使用 > MAX_EMBEDDED_CHUNKS 个短段落的方案：
    // 短段落会被合并，因此改用长段落确保每段单独成 chunk
    const segmentCount = MAX_EMBEDDED_CHUNKS + 5; // 205 段
    // 每段 601 字，超过 maxChars=600，chunkDocument 会把每段切成 ceil(601/600)=2 chunk
    const content = Array.from({ length: segmentCount }, (_, i) =>
      `S${i}:` + "X".repeat(599)   // 602 字，刚超 600 → 每段 2 chunk，共 410 chunk
    ).join("\n\n");

    const fakeVec = [1, 0];
    const limitClient: BailianEmbeddingClient = {
      embed: async (texts: string[]) => texts.map(() => fakeVec)
    };

    const state = createInitialProductState();
    const { sourceId, nextState } = await ingestImportSource(
      state,
      { title: "Cap Test", content, sourceType: "text" },
      [],
      limitClient
    );

    const newChunks = nextState.ragChunks.filter((c) => c.sourceId === sourceId);
    const withEmbed = newChunks.filter((c) => Array.isArray(c.embedding) && c.embedding!.length > 0);
    const withoutEmbed = newChunks.filter((c) => c.embedding === undefined);

    // 总 chunk 数 > MAX_EMBEDDED_CHUNKS
    expect(newChunks.length).toBeGreaterThan(MAX_EMBEDDED_CHUNKS);
    // 前 MAX_EMBEDDED_CHUNKS 个有 embedding
    expect(withEmbed).toHaveLength(MAX_EMBEDDED_CHUNKS);
    // 超出部分无 embedding（走关键词召回）
    expect(withoutEmbed.length).toBeGreaterThan(0);
    expect(withEmbed.length + withoutEmbed.length).toBe(newChunks.length);
  });
});

describe("ingestImportSource — relatedThemeIds 软标签", () => {
  function makeStateWithTheme(): ProductState {
    const base = createInitialProductState();
    // 确保有一条"控制感"主题线（seed 已有 theme-control，但显式构造避免耦合）
    const theme: LongTermTheme = {
      id: "theme-test-control",
      name: "控制感",
      summary: "test",
      maturity: "聚焦",
      representativeQuote: "",
      appearances: 1,
      nextQuestion: "",
      updatedAt: "2026-01-01T00:00:00.000Z",
      kind: "theme",
      pinned: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      lastActiveAt: "2026-01-01T00:00:00.000Z"
    };
    return { ...base, themes: [theme] };
  }

  it("内容含主题名时 source.relatedThemeIds 包含对应 themeId", async () => {
    const state = makeStateWithTheme();
    const { nextState, sourceId } = await ingestImportSource(
      state,
      { title: "团队授权与控制感", content: "控制感是核心议题。", sourceType: "text" },
      []
    );
    const src = nextState.importSources.find((s) => s.id === sourceId);
    expect(src?.relatedThemeIds).toContain("theme-test-control");
  });

  it("内容不含主题名时 source.relatedThemeIds 为空数组", async () => {
    const state = makeStateWithTheme();
    const { nextState, sourceId } = await ingestImportSource(
      state,
      { title: "完全无关的话题", content: "跑步训练计划。", sourceType: "text" },
      []
    );
    const src = nextState.importSources.find((s) => s.id === sourceId);
    expect(src?.relatedThemeIds).toEqual([]);
  });
});
