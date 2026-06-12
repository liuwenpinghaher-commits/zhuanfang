import { describe, it, expect } from "vitest";

describe("Mastra agents", () => {
  it("interviewDirectorAgent is defined with name", async () => {
    const { interviewDirectorAgent } = await import("./interviewDirectorAgent");
    expect(interviewDirectorAgent).toBeDefined();
    expect(interviewDirectorAgent.name).toBe("Interview Director");
  });

  it("contextPackBuilderAgent is defined with name", async () => {
    const { contextPackBuilderAgent } = await import("./contextPackBuilderAgent");
    expect(contextPackBuilderAgent).toBeDefined();
    expect(contextPackBuilderAgent.name).toBe("Context Pack Builder");
  });

  it("assetExtractorAgent is defined with name", async () => {
    const { assetExtractorAgent } = await import("./assetExtractorAgent");
    expect(assetExtractorAgent).toBeDefined();
    expect(assetExtractorAgent.name).toBe("Asset Extractor");
  });

  it("memoryCandidateAgent is defined with name", async () => {
    const { memoryCandidateAgent } = await import("./memoryCandidateAgent");
    expect(memoryCandidateAgent).toBeDefined();
    expect(memoryCandidateAgent.name).toBe("Memory Candidate");
  });

  it("memoryConsolidationAgent is defined with name", async () => {
    const { memoryConsolidationAgent } = await import("./memoryConsolidationAgent");
    expect(memoryConsolidationAgent).toBeDefined();
    expect(memoryConsolidationAgent.name).toBe("Memory Consolidation");
  });

  it("importClassifierAgent is defined with name", async () => {
    const { importClassifierAgent } = await import("./importClassifierAgent");
    expect(importClassifierAgent).toBeDefined();
    expect(importClassifierAgent.name).toBe("Import Classifier");
  });

  it("transcriptCleanerAgent is defined with name", async () => {
    const { transcriptCleanerAgent } = await import("./transcriptCleanerAgent");
    expect(transcriptCleanerAgent).toBeDefined();
    expect(transcriptCleanerAgent.name).toBe("Transcript Cleaner");
  });

  it("interviewTechniqueAnalystAgent is defined with name", async () => {
    const { interviewTechniqueAnalystAgent } = await import(
      "./interviewTechniqueAnalystAgent"
    );
    expect(interviewTechniqueAnalystAgent).toBeDefined();
    expect(interviewTechniqueAnalystAgent.name).toBe("Interview Technique Analyst");
  });

  it("podcastGeneratorAgent is defined with name", async () => {
    const { podcastGeneratorAgent } = await import("./podcastGeneratorAgent");
    expect(podcastGeneratorAgent).toBeDefined();
    expect(podcastGeneratorAgent.name).toBe("Podcast Generator");
  });

  it("sensitiveReviewAgent is defined with name", async () => {
    const { sensitiveReviewAgent } = await import("./sensitiveReviewAgent");
    expect(sensitiveReviewAgent).toBeDefined();
    expect(sensitiveReviewAgent.name).toBe("Sensitive Review");
  });

  it("all 10 agents export from index", async () => {
    const agents = await import("./index");
    expect(agents.interviewDirectorAgent).toBeDefined();
    expect(agents.contextPackBuilderAgent).toBeDefined();
    expect(agents.assetExtractorAgent).toBeDefined();
    expect(agents.memoryCandidateAgent).toBeDefined();
    expect(agents.memoryConsolidationAgent).toBeDefined();
    expect(agents.importClassifierAgent).toBeDefined();
    expect(agents.transcriptCleanerAgent).toBeDefined();
    expect(agents.interviewTechniqueAnalystAgent).toBeDefined();
    expect(agents.podcastGeneratorAgent).toBeDefined();
    expect(agents.sensitiveReviewAgent).toBeDefined();
  });
});
