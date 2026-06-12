import { createTool } from "@mastra/core/tools";
import { z } from "zod";

export const graphTool = createTool({
  id: "graph",
  description:
    "Traverse memoryEdges in the product state for knowledge graph relationships",
  inputSchema: z.object({
    operation: z.enum(["expand", "related", "path"]),
    nodeId: z.string(),
    relationTypes: z.array(z.string()).optional(),
    maxDepth: z.number().default(2),
  }),
  outputSchema: z.object({
    nodeId: z.string(),
    operation: z.string(),
    related: z.array(z.any()),
    count: z.number(),
  }),
  execute: async ({ context }) => {
    const { operation, nodeId, relationTypes, maxDepth } = context;
    const apiBase =
      process.env.PRODUCT_API_BASE_URL || "http://127.0.0.1:8787";
    const state = await fetch(`${apiBase}/api/state`).then((r) => r.json());
    const edges = state.memoryEdges || [];

    const related = edges
      .filter((e: any) => {
        const typeMatch = relationTypes
          ? relationTypes.includes(e.relation)
          : true;
        return (e.sourceId === nodeId || e.targetId === nodeId) && typeMatch;
      })
      .map((e: any) => ({
        sourceId: e.sourceId,
        targetId: e.targetId,
        relation: e.relation,
        confidence: e.confidence,
      }));

    return { nodeId, operation, related, count: related.length };
  },
});
