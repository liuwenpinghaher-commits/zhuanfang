import type { ProductStateRepository } from "./product-state-repository.js";

export interface MastraIntegration {
  runWorkflow(workflowName: string, input: Record<string, unknown>): Promise<unknown>;
  getAgentNames(): string[];
  getWorkflowNames(): string[];
}

export function createMastraIntegration(stateRepo: ProductStateRepository): MastraIntegration {
  const agentNames = [
    "interviewDirector", "contextPackBuilder", "assetExtractor",
    "memoryCandidate", "memoryConsolidation", "importClassifier",
    "transcriptCleaner", "interviewTechniqueAnalyst",
    "podcastGenerator", "sensitiveReview",
  ];

  const workflowNames = [
    "interview-preparation", "context-pack-build", "live-interview-assist",
    "post-interview-extraction", "memory-candidate-review", "memory-projection",
    "import-ingestion", "audio-transcription", "document-ingestion",
    "reference-interview-learning", "podcast-generation", "memory-maintenance",
  ];

  return {
    async runWorkflow(workflowName: string, input: Record<string, unknown>) {
      try {
        const mastraUrl = process.env.MASTRA_RUNTIME_URL || "http://127.0.0.1:4111";
        const res = await fetch(`${mastraUrl}/api/workflows/${workflowName}/execute`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        });
        if (!res.ok) {
          throw new Error(`Mastra workflow ${workflowName} failed: ${res.status}`);
        }
        return await res.json();
      } catch (error) {
        console.warn(`Mastra runtime unavailable, workflow ${workflowName} skipped:`, error);
        return { degraded: true, workflowName, reason: "mastra-unavailable" };
      }
    },
    getAgentNames: () => agentNames,
    getWorkflowNames: () => workflowNames,
  };
}
