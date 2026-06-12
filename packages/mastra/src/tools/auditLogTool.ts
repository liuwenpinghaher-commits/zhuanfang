import { createTool } from "@mastra/core/tools";
import { z } from "zod";

export const auditLogTool = createTool({
  id: "auditLog",
  description: "Record audit events to the product state for compliance and debugging",
  inputSchema: z.object({
    eventType: z.string(),
    entityType: z.string(),
    entityId: z.string(),
    severity: z
      .enum(["info", "warning", "error", "critical"])
      .default("info"),
    detail: z.record(z.any()).optional(),
  }),
  outputSchema: z.object({
    recorded: z.boolean(),
    eventId: z.string(),
  }),
  execute: async ({ context }) => {
    const { eventType, entityType, entityId, severity, detail } = context;
    const event = {
      id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      eventType,
      entityType,
      entityId,
      severity,
      detail: detail || {},
      createdAt: new Date().toISOString(),
    };
    const apiBase =
      process.env.PRODUCT_API_BASE_URL || "http://127.0.0.1:8787";
    const state = await fetch(`${apiBase}/api/state`).then((r) => r.json());
    state.auditEvents = [event, ...(state.auditEvents || [])];
    await fetch(`${apiBase}/api/state`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(state),
    });
    return { recorded: true, eventId: event.id };
  },
});
