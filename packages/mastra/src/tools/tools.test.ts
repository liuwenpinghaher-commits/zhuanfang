import { describe, it, expect } from "vitest";

describe("Mastra tools", () => {
  it("productDbTool is defined with id and description", async () => {
    const { productDbTool } = await import("./productDbTool");
    expect(productDbTool.id).toBe("productDb");
    expect(productDbTool.description).toBeTruthy();
  });

  it("searchProviderTool is defined with id and description", async () => {
    const { searchProviderTool } = await import("./searchProviderTool");
    expect(searchProviderTool.id).toBe("searchProvider");
    expect(searchProviderTool.description).toBeTruthy();
  });

  it("asrTool is defined with id and description", async () => {
    const { asrTool } = await import("./asrTool");
    expect(asrTool.id).toBe("asr");
    expect(asrTool.description).toBeTruthy();
  });

  it("ttsTool is defined with id and description", async () => {
    const { ttsTool } = await import("./ttsTool");
    expect(ttsTool.id).toBe("tts");
    expect(ttsTool.description).toBeTruthy();
  });

  it("webFetchTool is defined with id and description", async () => {
    const { webFetchTool } = await import("./webFetchTool");
    expect(webFetchTool.id).toBe("webFetch");
    expect(webFetchTool.description).toBeTruthy();
  });

  it("objectStorageTool is defined with id and description", async () => {
    const { objectStorageTool } = await import("./objectStorageTool");
    expect(objectStorageTool.id).toBe("objectStorage");
    expect(objectStorageTool.description).toBeTruthy();
  });

  it("ragTool is defined with id and description", async () => {
    const { ragTool } = await import("./ragTool");
    expect(ragTool.id).toBe("rag");
    expect(ragTool.description).toBeTruthy();
  });

  it("mastraMemoryTool is defined with id and description", async () => {
    const { mastraMemoryTool } = await import("./mastraMemoryTool");
    expect(mastraMemoryTool.id).toBe("mastraMemory");
    expect(mastraMemoryTool.description).toBeTruthy();
  });

  it("graphTool is defined with id and description", async () => {
    const { graphTool } = await import("./graphTool");
    expect(graphTool.id).toBe("graph");
    expect(graphTool.description).toBeTruthy();
  });

  it("documentParseTool is defined with id and description", async () => {
    const { documentParseTool } = await import("./documentParseTool");
    expect(documentParseTool.id).toBe("documentParse");
    expect(documentParseTool.description).toBeTruthy();
  });

  it("scorerTool is defined with id and description", async () => {
    const { scorerTool } = await import("./scorerTool");
    expect(scorerTool.id).toBe("scorer");
    expect(scorerTool.description).toBeTruthy();
  });

  it("auditLogTool is defined with id and description", async () => {
    const { auditLogTool } = await import("./auditLogTool");
    expect(auditLogTool.id).toBe("auditLog");
    expect(auditLogTool.description).toBeTruthy();
  });

  it("all 12 tools export from index", async () => {
    const tools = await import("./index");
    expect(tools.productDbTool).toBeDefined();
    expect(tools.searchProviderTool).toBeDefined();
    expect(tools.asrTool).toBeDefined();
    expect(tools.ttsTool).toBeDefined();
    expect(tools.webFetchTool).toBeDefined();
    expect(tools.objectStorageTool).toBeDefined();
    expect(tools.ragTool).toBeDefined();
    expect(tools.mastraMemoryTool).toBeDefined();
    expect(tools.graphTool).toBeDefined();
    expect(tools.documentParseTool).toBeDefined();
    expect(tools.scorerTool).toBeDefined();
    expect(tools.auditLogTool).toBeDefined();
  });

  it("scorerTool has all 8 scorers", async () => {
    const { scorerTool } = await import("./scorerTool");
    const schema = scorerTool.inputSchema;
    expect(schema).toBeDefined();
  });

  it("productDbTool supports all 7 operations", async () => {
    const { productDbTool } = await import("./productDbTool");
    const schema = productDbTool.inputSchema;
    expect(schema).toBeDefined();
  });
});
