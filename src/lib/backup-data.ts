import { z } from "zod";
import { and, eq } from "drizzle-orm";
import {
  db,
  customFoods,
  diaryDays,
  foodEntries,
  nutritionTargets,
  savedFoods,
  savedMeals,
  recipes,
  weightEntries,
  preferences,
  healthLinks,
  coachingGoals,
  checkIns,
} from "@/db";
import { localDay } from "./metrics";
import { recipeFood, shiftDay, validateFood, type Food, type Recipe } from "./nutrition";

export const MAX_BACKUP_TEXT = 20 * 1024 * 1024;
const text = z.string().max(20000);
const positive = z.number().finite().positive();
const id = z.number().int().positive();
const timestamp = z.number().int().nonnegative().max(8640000000000000);
const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const parsed = new Date(`${value}T12:00:00Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  });
const nutrients = z.strictObject({
  calories: z.number().finite().min(0).max(1e12),
  protein: z.number().finite().min(0).max(1e12),
  carbs: z.number().finite().min(0).max(1e12),
  fat: z.number().finite().min(0).max(1e12),
  fiber: z.number().finite().min(0).max(1e12).nullable(),
  sodium: z.number().finite().min(0).max(1e12).nullable(),
});
const food = z
  .strictObject({
    id: text.min(1),
    name: text.min(1),
    brand: text,
    barcode: text.nullable(),
    basis: z.enum(["g", "ml", "serving"]),
    nutrients,
    portions: z.array(z.strictObject({ label: text, amount: positive.max(100000) })).max(100),
    source: z.enum(["usda", "off", "custom", "recipe"]),
    sourceVersion: text,
  })
  .refine((value) => {
    try {
      validateFood(value as Food);
      return true;
    } catch {
      return false;
    }
  }, "Invalid food");
const meal = z.enum(["Breakfast", "Lunch", "Dinner", "Snacks"]);
const item = z.strictObject({
  food,
  amount: positive.max(100000),
  portionLabel: text.min(1),
  // Added after the first backups, which restore with neither.
  portionUnit: z.string().max(80).nullable().optional(),
  portionCount: positive.max(100000).nullable().optional(),
  nutrients,
});
const iso = z.iso.datetime();
const targetSchema = z.strictObject({
  calories: positive.max(10000),
  protein: z.number().min(0).max(1500),
  carbs: z.number().min(0).max(1500),
  fat: z.number().min(0).max(1500),
});
const reviewSchema = z.strictObject({
  method: z.union([z.literal(1), z.literal(2)]),
  trendWeightKg: positive.max(1000).optional(),
  targetWeightKg: positive.max(1000).optional(),
  observedDays: z.number().int().min(0).max(21).optional(),
  day,
  start: day,
  end: day,
  completeDays: z.number().int().min(0).max(21),
  weightDays: z.number().int().min(0).max(21),
  status: z.enum(["learning", "holding", "ready"]),
  reason: text,
  intake: z.number().finite().nullable(),
  expenditure: z.number().finite().nullable(),
  weeklyKg: z.number().finite().nullable(),
  desiredWeeklyKg: z.number().finite().nullable(),
  proposed: targetSchema.nullable(),
});
const dataSchema = z.strictObject({
  goals: z
    .array(
      z
        .strictObject({
          id,
          mode: z.enum(["manual", "lose", "maintain", "gain"]),
          pace: z.number().min(0).max(0.5),
          startedDay: day,
          program: z
            .strictObject({
              age: z.number().int().min(18).max(100),
              heightCm: z.number().min(120).max(230),
              weightKg: z.number().min(35).max(350),
              formula: z.enum(["female", "male"]),
              activity: z.enum(["low", "light", "moderate", "high"]),
              protein: z.union([z.literal(1.4), z.literal(1.6), z.literal(2), z.literal(2.2)]),
              diet: z.enum(["balanced", "lower-fat", "lower-carb"]),
              targetWeightKg: z.number().min(35).max(350),
              initialExpenditure: z.number().min(1200).max(5000),
              checkInDay: z.number().int().min(0).max(6),
              custom: z
                .strictObject({
                  proteinG: z.number().min(40).max(500).optional(),
                  carbPct: z.number().min(0).max(100).optional(),
                })
                .optional(),
              // Added with calorie shifting; older backups restore without it.
              shift: z
                .strictObject({
                  days: z
                    .array(z.number().int().min(0).max(6))
                    .min(1)
                    .max(6)
                    .refine((days) => new Set(days).size === days.length),
                  size: z.number().positive().max(1000),
                  unit: z.enum(["%", "kcal"]),
                })
                .optional(),
            })
            .nullable()
            .optional(),
        })
        .refine((row) => row.mode !== "gain" || row.pace <= 0.25)
    )
    .max(10000)
    .default([]),
  checkIns: z
    .array(
      z.strictObject({
        day,
        goalId: id,
        decision: z.enum(["accepted", "kept", "adjusted"]),
        review: reviewSchema,
        targets: targetSchema,
      })
    )
    .max(10000)
    .default([]),
  entries: z
    .array(
      item.extend({
        id,
        day,
        meal,
        loggedTime: z
          .string()
          .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
          .nullable()
          .optional(),
        createdAt: timestamp,
      })
    )
    .max(100000),
  customFoods: z
    .array(
      z
        .strictObject({ id: text.min(1), name: text.min(1), barcode: text.nullable(), food })
        .refine(
          (row) =>
            row.id === row.food.id &&
            row.food.source === "custom" &&
            row.barcode === row.food.barcode
        )
    )
    .max(10000),
  favorites: z
    .array(
      z
        .strictObject({ id: text.min(1), food, savedAt: timestamp })
        .refine((row) => row.id === row.food.id)
    )
    .max(10000),
  savedMeals: z
    .array(
      z.strictObject({
        id,
        name: text.min(1).max(80),
        items: z.array(item).min(1).max(10000),
        createdAt: timestamp,
      })
    )
    .max(10000),
  recipes: z
    .array(
      z
        .strictObject({
          id: text.min(1),
          name: text.min(1).max(80),
          servings: positive.max(1000),
          yieldGrams: positive.max(100000).nullable().optional(),
          ingredients: z
            .array(z.strictObject({ food, amount: positive.max(100000) }))
            .min(1)
            .max(100),
          revision: id,
        })
        .refine((row) => {
          try {
            recipeFood(row as Recipe);
            return true;
          } catch {
            return false;
          }
        })
    )
    .max(10000),
  days: z
    .array(
      z.strictObject({ day, status: z.enum(["in-progress", "complete", "partial", "fasting"]) })
    )
    .max(100000),
  targets: z
    .array(
      z.strictObject({
        effectiveDay: day,
        targets: z.strictObject({
          calories: positive.max(10000),
          protein: z.number().finite().min(0).max(1500),
          carbs: z.number().finite().min(0).max(1500),
          fat: z.number().finite().min(0).max(1500),
        }),
      })
    )
    .max(100000),
  weights: z
    .array(
      z.strictObject({
        id,
        weightKg: positive.max(1000),
        measuredAt: z
          .string()
          .max(100)
          .refine((value) => Number.isFinite(Date.parse(value))),
        createdAt: iso.nullable(),
        updatedAt: iso.nullable(),
        // Backups made before readings could be ignored count every reading.
        excluded: z.boolean().default(false),
        // The Health sample a reading was imported from, so a restore keeps them linked.
        healthId: text.min(1).optional(),
      })
    )
    .max(100000),
});
const schema = z
  .strictObject({
    format: z.literal("macro-track-backup"),
    version: z.literal(1),
    createdAt: iso,
    data: dataSchema,
  })
  .superRefine((backup, context) => {
    for (const [name, rows] of Object.entries(backup.data)) {
      const keys = rows.map((row) =>
        "id" in row
          ? row.id
          : "day" in row
            ? row.day
            : "effectiveDay" in row
              ? row.effectiveDay
              : ""
      );
      if (new Set(keys).size !== keys.length)
        context.addIssue({ code: "custom", message: `Duplicate keys in ${name}` });
    }
    const goalIds = new Set(backup.data.goals.map((row) => row.id));
    if (backup.data.checkIns.some((row) => !goalIds.has(row.goalId) || row.day !== row.review.day))
      context.addIssue({ code: "custom", message: "Invalid check-in goal or date" });
    const logged = new Set(backup.data.entries.map((entry) => entry.day));
    if (
      backup.data.days.some(
        (row) =>
          (row.status === "fasting" && logged.has(row.day)) ||
          (row.status === "complete" && !logged.has(row.day))
      )
    )
      context.addIssue({ code: "custom", message: "Inconsistent logging status" });
  });
export type Backup = z.infer<typeof schema>;

export function validateBackup(value: unknown): Backup {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new Error("This backup is invalid or uses an unsupported version. Nothing was restored.");
  return result.data;
}
export function parseBackup(json: string): Backup {
  if (json.length > MAX_BACKUP_TEXT) throw new Error("This backup exceeds the 20 MB data limit.");
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error("This backup could not be read.");
  }
  return validateBackup(value);
}
export function createBackup(): Backup {
  const snapshot = db.transaction((tx) => {
    const imported = new Map(
      tx
        .select()
        .from(healthLinks)
        .where(and(eq(healthLinks.origin, "health"), eq(healthLinks.localKind, "weight")))
        .all()
        .map((link) => [link.localId, link.remoteId])
    );
    return {
      format: "macro-track-backup",
      version: 1,
      createdAt: new Date().toISOString(),
      data: {
        goals: tx.select().from(coachingGoals).all(),
        checkIns: tx.select().from(checkIns).all(),
        entries: tx.select().from(foodEntries).all(),
        customFoods: tx.select().from(customFoods).all(),
        favorites: tx.select().from(savedFoods).all(),
        savedMeals: tx.select().from(savedMeals).all(),
        recipes: tx.select().from(recipes).all(),
        days: tx.select().from(diaryDays).all(),
        targets: tx.select().from(nutritionTargets).all(),
        weights: tx
          .select()
          .from(weightEntries)
          .all()
          .map((row) => ({ ...row, healthId: imported.get(row.id) })),
      },
    };
  });
  return parseBackup(JSON.stringify(snapshot));
}

// Caller holds the health-sync maintenance lock. All replacement writes roll back
// together if storage fails; catalog files, photos and measurements are untouched.
export function restoreBackup(value: unknown, recoveryUri?: string) {
  const { data } = validateBackup(value);
  db.transaction((tx) => {
    tx.delete(checkIns).run();
    tx.delete(coachingGoals).run();
    for (const row of data.goals) tx.insert(coachingGoals).values(row).run();
    for (const row of data.checkIns) tx.insert(checkIns).values(row).run();
    tx.delete(foodEntries).run();
    tx.delete(customFoods).run();
    tx.delete(savedFoods).run();
    tx.delete(savedMeals).run();
    tx.delete(recipes).run();
    tx.delete(diaryDays).run();
    tx.delete(nutritionTargets).run();
    tx.delete(weightEntries).run();
    tx.delete(healthLinks).where(eq(healthLinks.localKind, "weight")).run();
    for (const row of data.entries) tx.insert(foodEntries).values(row).run();
    for (const row of data.customFoods) tx.insert(customFoods).values(row).run();
    for (const row of data.favorites) tx.insert(savedFoods).values(row).run();
    for (const row of data.savedMeals) tx.insert(savedMeals).values(row).run();
    for (const row of data.recipes) tx.insert(recipes).values(row).run();
    for (const row of data.days) tx.insert(diaryDays).values(row).run();
    for (const row of data.targets) tx.insert(nutritionTargets).values(row).run();
    for (const { healthId, ...row } of data.weights) {
      tx.insert(weightEntries)
        .values({
          ...row,
          createdAt: row.createdAt ? new Date(row.createdAt) : null,
          updatedAt: row.updatedAt ? new Date(row.updatedAt) : null,
        })
        .run();
      // A reading from Health keeps its sample, so sync neither imports it again nor writes it
      // back and an ignored one stays ignored. Imported readings can't be edited, so the row
      // still matches the sample's fingerprint.
      if (healthId)
        tx.insert(healthLinks)
          .values({
            key: `health:weight:${healthId}`,
            localKind: "weight",
            localId: row.id,
            remoteId: healthId,
            fingerprint: `${row.weightKg}:${row.measuredAt}`,
            origin: "health",
          })
          .onConflictDoNothing()
          .run();
    }
    if (recoveryUri)
      tx.insert(preferences)
        .values({ key: "recoveryBackupUri", value: recoveryUri })
        .onConflictDoUpdate({ target: preferences.key, set: { value: recoveryUri } })
        .run();
    for (const [key, value] of [
      ["healthSyncEnabled", "false"],
      ["weightSyncEpoch", `${Date.now()}-${Math.random().toString(36).slice(2)}`],
      ["healthSyncError", ""],
      ["lastSync", ""],
      // An answer about yesterday isn't in the backup, so Home asks instead of counting it.
      ["settledDay", shiftDay(localDay(), -1)],
    ])
      tx.insert(preferences)
        .values({ key, value })
        .onConflictDoUpdate({ target: preferences.key, set: { value } })
        .run();
  });
}
