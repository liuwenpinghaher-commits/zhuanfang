import { describe, it, expect } from "vitest";

describe("Mastra workflows", () => {
  it("interviewPreparationWorkflow is defined with id", async () => {
    const { interviewPreparationWorkflow } = await import(
      "./interviewPreparationWorkflow"
    );
    expect(interviewPreparationWorkflow).toBeDefined();
    expect(interviewPreparationWorkflow.id).toBe("interview-preparation");
  });

  it("contextPackBuildWorkflow is defined with id", async () => {
    const { contextPackBuildWorkflow } = await import(
      "./contextPackBuildWorkflow"
    );
    expect(contextPackBuildWorkflow).toBeDefined();
    expect(contextPackBuildWorkflow.id).toBe("context-pack-build");
  });

  it("liveInterviewAssistWorkflow is defined with id", async () => {
    const { liveInterviewAssistWorkflow } = await import(
      "./liveInterviewAssistWorkflow"
    );
    expect(liveInterviewAssistWorkflow).toBeDefined();
    expect(liveInterviewAssistWorkflow.id).toBe("live-interview-assist");
  });

  it("postInterviewExtractionWorkflow is defined with id", async () => {
    const { postInterviewExtractionWorkflow } = await import(
      "./postInterviewExtractionWorkflow"
    );
    expect(postInterviewExtractionWorkflow).toBeDefined();
    expect(postInterviewExtractionWorkflow.id).toBe("post-interview-extraction");
  });

  it("memoryCandidateReviewWorkflow is defined with id", async () => {
    const { memoryCandidateReviewWorkflow } = await import(
      "./memoryCandidateReviewWorkflow"
    );
    expect(memoryCandidateReviewWorkflow).toBeDefined();
    expect(memoryCandidateReviewWorkflow.id).toBe("memory-candidate-review");
  });

  it("memoryProjectionWorkflow is defined with id", async () => {
    const { memoryProjectionWorkflow } = await import(
      "./memoryProjectionWorkflow"
    );
    expect(memoryProjectionWorkflow).toBeDefined();
    expect(memoryProjectionWorkflow.id).toBe("memory-projection");
  });

  it("importIngestionWorkflow is defined with id", async () => {
    const { importIngestionWorkflow } = await import(
      "./importIngestionWorkflow"
    );
    expect(importIngestionWorkflow).toBeDefined();
    expect(importIngestionWorkflow.id).toBe("import-ingestion");
  });

  it("audioTranscriptionWorkflow is defined with id", async () => {
    const { audioTranscriptionWorkflow } = await import(
      "./audioTranscriptionWorkflow"
    );
    expect(audioTranscriptionWorkflow).toBeDefined();
    expect(audioTranscriptionWorkflow.id).toBe("audio-transcription");
  });

  it("documentIngestionWorkflow is defined with id", async () => {
    const { documentIngestionWorkflow } = await import(
      "./documentIngestionWorkflow"
    );
    expect(documentIngestionWorkflow).toBeDefined();
    expect(documentIngestionWorkflow.id).toBe("document-ingestion");
  });

  it("referenceInterviewLearningWorkflow is defined with id", async () => {
    const { referenceInterviewLearningWorkflow } = await import(
      "./referenceInterviewLearningWorkflow"
    );
    expect(referenceInterviewLearningWorkflow).toBeDefined();
    expect(referenceInterviewLearningWorkflow.id).toBe(
      "reference-interview-learning",
    );
  });

  it("podcastGenerationWorkflow is defined with id", async () => {
    const { podcastGenerationWorkflow } = await import(
      "./podcastGenerationWorkflow"
    );
    expect(podcastGenerationWorkflow).toBeDefined();
    expect(podcastGenerationWorkflow.id).toBe("podcast-generation");
  });

  it("memoryMaintenanceWorkflow is defined with id", async () => {
    const { memoryMaintenanceWorkflow } = await import(
      "./memoryMaintenanceWorkflow"
    );
    expect(memoryMaintenanceWorkflow).toBeDefined();
    expect(memoryMaintenanceWorkflow.id).toBe("memory-maintenance");
  });

  it("all 12 workflows export from index", async () => {
    const workflows = await import("./index");
    expect(workflows.interviewPreparationWorkflow).toBeDefined();
    expect(workflows.contextPackBuildWorkflow).toBeDefined();
    expect(workflows.liveInterviewAssistWorkflow).toBeDefined();
    expect(workflows.postInterviewExtractionWorkflow).toBeDefined();
    expect(workflows.memoryCandidateReviewWorkflow).toBeDefined();
    expect(workflows.memoryProjectionWorkflow).toBeDefined();
    expect(workflows.importIngestionWorkflow).toBeDefined();
    expect(workflows.audioTranscriptionWorkflow).toBeDefined();
    expect(workflows.documentIngestionWorkflow).toBeDefined();
    expect(workflows.referenceInterviewLearningWorkflow).toBeDefined();
    expect(workflows.podcastGenerationWorkflow).toBeDefined();
    expect(workflows.memoryMaintenanceWorkflow).toBeDefined();
  });
});
