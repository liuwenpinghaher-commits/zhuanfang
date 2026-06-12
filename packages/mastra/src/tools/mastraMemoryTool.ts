import { createTool } from "@mastra/core/tools";
import { z } from "zod";

export const mastraMemoryTool = createTool({
  id: "mastraMemory",
  description:
    "Memory operations (recall, workingMemory) using product state memoryRecords",
  inputSchema: z.object({
    operation: z.enum(["recall", "workingMemory"]),
    query: z.string().optional(),
  }),
  outputSchema: z.object({
    result: z.any(),
  }),
  execute: async ({ context }) => {
    const { operation, query } = context;
    const apiBase =
      process.env.PRODUCT_API_BASE_URL || "http://127.0.0.1:8787";
    const state = await fetch(`${apiBase}/api/state`).then((r) => r.json());

    switch (operation) {
      case "recall": {
        const records = state.memoryRecords || [];
        const matched = query
          ? records.filter((r: any) =>
              r.text.toLowerCase().includes(query.toLowerCase()),
            )
          : records;
        return { result: { memories: matched.slice(0, 10) } };
      }
      case "workingMemory": {
        return {
          result: {
            recentSessions: (state.sessions || []).slice(-3),
            recentNotes: (state.notes || []).slice(-3),
            activeThemes: (state.themes || []).filter(
              (t: any) => t.maturity !== "mature",
            ),
            openDebts: (state.debts || []).filter(
              (d: any) => d.status !== "已解决",
            ),
          },
        };
      }
      default:
        return { result: { operation, status: "ok" } };
    }
  },
});
