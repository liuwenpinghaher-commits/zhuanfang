import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { ProductState } from "../../../src/domain/types";

export const productStateSnapshots = sqliteTable("product_state_snapshots", {
  id: text("id").primaryKey(),
  stateJson: text("state_json", { mode: "json" }).notNull().$type<ProductState>(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
});

export const productStateEvents = sqliteTable("product_state_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  eventType: text("event_type", { enum: ["seed", "replace", "reset"] }).notNull(),
  stateJson: text("state_json", { mode: "json" }).notNull().$type<ProductState>(),
  createdAt: text("created_at").notNull()
});
