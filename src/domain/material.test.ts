import { describe, expect, it } from "vitest";
import { createInitialProductState } from "./engine";
import { deleteImportSource } from "./material";
import type { ImportSource, ProductState, RagChunk } from "./types";

function seedSourceWithChunks(state: ProductState, sourceId: string): ProductState {
  const source: ImportSource = {
    id: sourceId,
    title: "导入资料",
    sourceType: "text",
    content: "正文内容",
    status: "chunked",
    sensitivity: "normal",
    chunkIds: [`${sourceId}-chunk-1`, `${sourceId}-chunk-2`],
    createdAt: "2026-06-21T00:00:00.000Z",
    updatedAt: "2026-06-21T00:00:00.000Z"
  };
  const chunks: RagChunk[] = [
    {
      id: `${sourceId}-chunk-1`,
      sourceId,
      title: "导入资料",
      text: "块一",
      keywords: ["块一"],
      tokenEstimate: 4,
      usage: "interview-context",
      createdAt: "2026-06-21T00:00:00.000Z"
    },
    {
      id: `${sourceId}-chunk-2`,
      sourceId,
      title: "导入资料",
      text: "块二",
      keywords: ["块二"],
      tokenEstimate: 4,
      usage: "interview-context",
      createdAt: "2026-06-21T00:00:00.000Z"
    }
  ];
  return {
    ...state,
    importSources: [...state.importSources, source],
    ragChunks: [...state.ragChunks, ...chunks]
  };
}

describe("deleteImportSource", () => {
  it("removes the import source and its rag chunks", () => {
    const base = seedSourceWithChunks(createInitialProductState(), "src-1");
    const otherChunk: RagChunk = {
      id: "src-2-chunk",
      sourceId: "src-2",
      title: "其他来源",
      text: "保留",
      keywords: ["保留"],
      tokenEstimate: 4,
      usage: "interview-context",
      createdAt: "2026-06-21T00:00:00.000Z"
    };
    const withOther: ProductState = { ...base, ragChunks: [...base.ragChunks, otherChunk] };

    const next = deleteImportSource(withOther, "src-1");

    expect(next.importSources.some((s) => s.id === "src-1")).toBe(false);
    expect(next.ragChunks.some((c) => c.sourceId === "src-1")).toBe(false);
    // unrelated chunks survive
    expect(next.ragChunks.some((c) => c.id === "src-2-chunk")).toBe(true);
  });

  it("records an import_source_deleted audit event", () => {
    const base = seedSourceWithChunks(createInitialProductState(), "src-1");

    const next = deleteImportSource(base, "src-1");

    const event = next.auditEvents.find((e) => e.type === "import_source_deleted");
    expect(event).toBeDefined();
    expect(event?.entityType).toBe("import_source");
    expect(event?.entityId).toBe("src-1");
  });

  it("returns an equivalent state when the source does not exist", () => {
    const base = seedSourceWithChunks(createInitialProductState(), "src-1");

    const next = deleteImportSource(base, "missing");

    expect(next.importSources).toHaveLength(base.importSources.length);
    expect(next.ragChunks).toHaveLength(base.ragChunks.length);
    // no spurious audit event
    expect(next.auditEvents.some((e) => e.type === "import_source_deleted")).toBe(false);
  });

  it("does not mutate the previous state", () => {
    const base = seedSourceWithChunks(createInitialProductState(), "src-1");
    const beforeSources = base.importSources.length;
    const beforeChunks = base.ragChunks.length;

    deleteImportSource(base, "src-1");

    expect(base.importSources).toHaveLength(beforeSources);
    expect(base.ragChunks).toHaveLength(beforeChunks);
  });
});
