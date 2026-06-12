export const chunkingConfig = {
  strategies: {
    sentence: { maxChunkSize: 500, minChunkSize: 50, overlap: 50 },
    recursive: { maxChunkSize: 1000, minChunkSize: 100, overlap: 100, separators: ["\n\n", "\n", "。", ". ", " "] },
    semanticMarkdown: { maxChunkSize: 1500, minChunkSize: 200, overlap: 150 },
    markdown: { maxChunkSize: 2000, minChunkSize: 200, overlap: 200 },
    html: { maxChunkSize: 2000, minChunkSize: 200, overlap: 200 },
    json: { maxChunkSize: 1000, minChunkSize: 100, overlap: 100 },
  },
  defaultStrategy: "recursive" as const,
};
