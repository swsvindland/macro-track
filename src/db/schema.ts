import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const counterLogs = sqliteTable("counter_logs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  count: integer("count").notNull(),
  date: text("date").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

export type CounterLog = typeof counterLogs.$inferSelect;

export const weightEntries = sqliteTable("weight_entries", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  weightKg: real("weight_kg").notNull(),
  measuredAt: text("measured_at").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

export type WeightEntry = typeof weightEntries.$inferSelect;

export const measurements = sqliteTable("measurements", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  kind: text("kind", { enum: ["height", "body"] }).notNull(),
  measuredAt: text("measured_at").notNull(),
  values: text("values", { mode: "json" }).$type<Record<string, number>>().notNull(),
  updatedAt: integer("updated_at").notNull(),
});
export type Measurement = typeof measurements.$inferSelect;

export const preferences = sqliteTable("preferences", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const photos = sqliteTable("photos", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  uri: text("uri").notNull(),
  pose: text("pose", { enum: ["front", "side", "back"] }).notNull(),
  measuredAt: text("measured_at").notNull(),
});
export type ProgressPhoto = typeof photos.$inferSelect;

// A mapping also remembers imported records after local deletion, so sync won't resurrect them.
export const healthLinks = sqliteTable("health_links", {
  key: text("key").primaryKey(),
  localKind: text("local_kind").notNull(),
  localId: integer("local_id").notNull(),
  remoteId: text("remote_id").notNull(),
  fingerprint: text("fingerprint").notNull(),
  origin: text("origin", { enum: ["local", "health"] }).notNull(),
});
