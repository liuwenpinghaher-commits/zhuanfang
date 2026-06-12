import {
  pgTable,
  text,
  integer,
  timestamp,
  jsonb,
  real,
  bigserial,
} from "drizzle-orm/pg-core";

export const productStateSnapshots = pgTable("product_state_snapshots", {
  id: text("id").primaryKey(),
  stateJson: jsonb("state_json").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const productStateEvents = pgTable("product_state_events", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  eventType: text("event_type").notNull(),
  stateJson: jsonb("state_json").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const memoryRecords = pgTable("memory_records", {
  id: text("id").primaryKey(),
  text: text("text").notNull(),
  status: text("status").notNull(),
  type: text("type"),
  sourceType: text("source_type").notNull(),
  sourceId: text("source_id").notNull(),
  evidenceQuote: text("evidence_quote").notNull(),
  sourceCandidateId: text("source_candidate_id"),
  sensitivity: text("sensitivity"),
  confidenceScore: real("confidence_score"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  lastConfirmedAt: timestamp("last_confirmed_at"),
  lastChallengedAt: timestamp("last_challenged_at"),
  deprecatedReason: text("deprecated_reason"),
});

export const memoryEdges = pgTable("memory_edges", {
  id: text("id").primaryKey(),
  sourceId: text("source_id").notNull(),
  targetId: text("target_id").notNull(),
  relation: text("relation").notNull(),
  confidence: real("confidence"),
  evidence: text("evidence"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const memoryCandidates = pgTable("memory_candidates", {
  id: text("id").primaryKey(),
  text: text("text").notNull(),
  status: text("status").notNull(),
  sourceType: text("source_type").notNull(),
  sourceId: text("source_id").notNull(),
  evidenceQuote: text("evidence_quote").notNull(),
  reason: text("reason").notNull(),
  sensitivity: text("sensitivity").notNull(),
  reviewScore: real("review_score"),
  reviewSignals: jsonb("review_signals"),
  reviewerDecision: text("reviewer_decision"),
  reviewNote: text("review_note"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  reviewedAt: timestamp("reviewed_at"),
});

export const importSources = pgTable("import_sources", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  mediaType: text("media_type").notNull(),
  sourceUrl: text("source_url"),
  status: text("status").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const ragChunks = pgTable("rag_chunks", {
  id: text("id").primaryKey(),
  sourceId: text("source_id").notNull(),
  sourceType: text("source_type").notNull(),
  content: text("content").notNull(),
  chunkIndex: integer("chunk_index"),
  metadata: jsonb("metadata"),
  embedding: text("embedding"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const auditEvents = pgTable("audit_events", {
  id: text("id").primaryKey(),
  eventType: text("event_type").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  severity: text("severity").notNull(),
  detail: jsonb("detail"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const aiRunEvents = pgTable("ai_run_events", {
  id: text("id").primaryKey(),
  workflowType: text("workflow_type").notNull(),
  status: text("status").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  inputSummary: text("input_summary"),
  outputSummary: text("output_summary"),
  latencyMs: integer("latency_ms"),
  estimatedTokens: integer("estimated_tokens"),
  degradedReason: text("degraded_reason"),
  traceId: text("trace_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
