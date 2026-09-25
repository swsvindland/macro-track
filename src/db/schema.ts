import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type {
  DayState,
  Food,
  Meal,
  MealItem,
  Nutrients,
  RecipeIngredient,
  Targets,
} from "@/lib/nutrition";

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

export const foodEntries = sqliteTable(
  "food_entries",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    day: text("day").notNull(),
    meal: text("meal").$type<Meal>().notNull(),
    loggedTime: text("logged_time"),
    food: text("food", { mode: "json" }).$type<Food>().notNull(),
    amount: real("amount").notNull(),
    portionLabel: text("portion_label").notNull(),
    nutrients: text("nutrients", { mode: "json" }).$type<Nutrients>().notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [index("food_entries_day_idx").on(table.day)]
);
export type FoodEntry = typeof foodEntries.$inferSelect;

export const customFoods = sqliteTable(
  "custom_foods",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    barcode: text("barcode"),
    food: text("food", { mode: "json" }).$type<Food>().notNull(),
  },
  (table) => [index("custom_foods_barcode_idx").on(table.barcode)]
);

export const savedFoods = sqliteTable("saved_foods", {
  id: text("id").primaryKey(),
  food: text("food", { mode: "json" }).$type<Food>().notNull(),
  savedAt: integer("saved_at").notNull(),
});

export const diaryDays = sqliteTable("diary_days", {
  day: text("day").primaryKey(),
  status: text("status").$type<DayState>().notNull(),
});

export const nutritionTargets = sqliteTable("nutrition_targets", {
  effectiveDay: text("effective_day").primaryKey(),
  targets: text("targets", { mode: "json" }).$type<Targets>().notNull(),
});

export const savedMeals = sqliteTable("saved_meals", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  items: text("items", { mode: "json" }).$type<MealItem[]>().notNull(),
  createdAt: integer("created_at").notNull(),
});
export type SavedMeal = typeof savedMeals.$inferSelect;

export const recipes = sqliteTable("recipes", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  servings: real("servings").notNull(),
  yieldGrams: real("yield_grams"),
  ingredients: text("ingredients", { mode: "json" }).$type<RecipeIngredient[]>().notNull(),
  revision: integer("revision").notNull(),
});

export const coachingGoals = sqliteTable("coaching_goals", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  mode: text("mode").$type<import("@/lib/coaching").Goal["mode"]>().notNull(),
  pace: real("pace").notNull(),
  startedDay: text("started_day").notNull(),
  program: text("program", { mode: "json" }).$type<import("@/lib/program").Program>(),
});
export const checkIns = sqliteTable("check_ins", {
  day: text("day").primaryKey(),
  goalId: integer("goal_id").notNull(),
  decision: text("decision").$type<"accepted" | "kept">().notNull(),
  review: text("review", { mode: "json" }).$type<import("@/lib/coaching").Review>().notNull(),
  targets: text("targets", { mode: "json" }).$type<Targets>().notNull(),
});
