import { Memory } from "@mastra/memory";

export const workingMemory = new Memory({
  options: {
    workingMemory: {
      enabled: true,
      maxTokens: 4000,
      template: `## User Profile
{{profile}}

## Recent Sessions (last 3)
{{recentSessions}}

## Active Themes
{{activeThemes}}

## Open Knowledge Debts
{{openDebts}}

## Pending Questions
{{pendingQuestions}}`,
    },
    semanticRecall: {
      enabled: true,
      topK: 10,
      messageRange: { before: 10, after: 5 },
    },
  },
  generateTitle: true,
  vector: "libsql" as const,
  embedder: "openai/text-embedding-3-small",
});
