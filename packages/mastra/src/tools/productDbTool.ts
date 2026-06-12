import { createTool } from "@mastra/core/tools";
import { z } from "zod";

export const productDbTool = createTool({
  id: "productDb",
  description:
    "Read and write product state including sessions, notes, assets, themes, memories, and config",
  inputSchema: z.object({
    operation: z.enum([
      "getState",
      "getSession",
      "getNotes",
      "getAssets",
      "getThemes",
      "getMemories",
      "updateState",
    ]),
    params: z.record(z.any()).optional(),
  }),
  outputSchema: z.object({
    result: z.any(),
  }),
  execute: async ({ context }) => {
    const { operation, params } = context;
    const apiBase =
      process.env.PRODUCT_API_BASE_URL || "http://127.0.0.1:8787";

    switch (operation) {
      case "getState": {
        const res = await fetch(`${apiBase}/api/state`);
        return { result: await res.json() };
      }
      case "getSession": {
        const res = await fetch(
          `${apiBase}/api/interview-sessions/${params?.sessionId}`,
        );
        return { result: await res.json() };
      }
      case "getNotes": {
        const state = await fetch(`${apiBase}/api/state`).then((r) => r.json());
        return { result: state.notes || [] };
      }
      case "getAssets": {
        const state = await fetch(`${apiBase}/api/state`).then((r) => r.json());
        return {
          result: {
            points: state.points || [],
            questions: state.questions || [],
            decisions: state.decisions || [],
            debts: state.debts || [],
          },
        };
      }
      case "getThemes": {
        const state = await fetch(`${apiBase}/api/state`).then((r) => r.json());
        return { result: state.themes || [] };
      }
      case "getMemories": {
        const state = await fetch(`${apiBase}/api/state`).then((r) => r.json());
        return {
          result: {
            records: state.memoryRecords || [],
            candidates: state.memoryCandidates || [],
            edges: state.memoryEdges || [],
          },
        };
      }
      case "updateState": {
        const res = await fetch(`${apiBase}/api/state`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(params?.state),
        });
        return { result: await res.json() };
      }
      default:
        throw new Error(`Unknown operation: ${operation}`);
    }
  },
});
