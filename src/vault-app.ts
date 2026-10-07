// Pendum Macros' vault descriptor (docs/vault.md §2; spec §4.4): what a backup holds, how a restore treats device
// state and Health provenance, and the app's hooks around both. It must load in Node: modules that reach native
// code, React or the live database are imported inside the functions that use them; the v1 adapter is the exception
// the spec allows (src/vault-legacy.ts: it parses synchronously, and its modules are Node-loadable). The bundled food
// catalogs are separate database files the vault never opens.
import type {
  DescribeContext,
  RestoreContext,
  VaultApp,
  VaultIssue,
  VaultSql,
} from "@/vault/types";
import { countWhere, jsonArray, jsonObject, notIn } from "@/vault/engine/db";
import { localDay } from "@/lib/metrics";
import { interpolate, translate, type Message } from "@/lib/translations";

import migrations from "../drizzle/migrations";
import { healthOff, macroLegacy } from "./vault-legacy";

/** App-generated photo names (`${Date.now()}-${random}.${ext}`). */
const MEDIA_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DAY = "'[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'";
/** Food written to Health before this many days ago is left alone (the first-sync window, spec §5.3). */
const FOOD_WINDOW_DAYS = 30;

/** The app's CSV builders start with a BOM; the vault adds its own. */
const withoutBom = (text: string) => text.replace(/^\uFEFF/, "");

/** "{count} recipes" / "{count} recipe"; nothing for zero. */
function count(ctx: DescribeContext, one: Message, other: Message, value: unknown) {
  const n = Number(value ?? 0);
  return n > 0
    ? [
        interpolate(translate(ctx.language, ctx.plural(n) === "one" ? one : other), {
          count: ctx.number(n),
        }),
      ]
    : [];
}

/** Provenance policy on the scratch DB (spec §5.3). The merge with the live links happens in the swap (§5.4). */
function healthPolicy(ctx: RestoreContext): VaultSql[] {
  if (ctx.legacy || ctx.sameDevice) return [];
  // The same day health.ts starts its first food export from.
  const since = localDay(new Date(ctx.now.getTime() - FOOD_WINDOW_DAYS * 86400000));
  if (ctx.crossPlatform)
    return [
      {
        sql: "DELETE FROM health_links WHERE origin = 'local' AND local_kind = 'food' AND local_id NOT IN (SELECT id FROM food_entries WHERE day >= ?)",
        params: [since],
      },
      { sql: "UPDATE health_links SET remote_id = '', fingerprint = '' WHERE origin = 'local'" },
      // The food window restarts 30 days back; weightSyncEpoch is kept (restored weights keep their keys).
      { sql: "DELETE FROM preferences WHERE key = 'healthFoodSince'" },
    ];
  return [
    {
      sql: "UPDATE health_links SET fingerprint = '' WHERE origin = 'local' AND fingerprint <> 'deleted' AND (local_kind <> 'food' OR local_id IN (SELECT id FROM food_entries WHERE day >= ?))",
      params: [since],
    },
  ];
}

export const vaultApp: VaultApp = {
  id: "macro",
  database: {
    name: "macro_track.db",
    acquire: async () => (await import("@/db")).expoDb,
    release: async () => {},
  },
  migrations,
  tables: [
    { name: "weight_entries", mode: "replace", role: "data" },
    { name: "measurements", mode: "replace", role: "data" },
    { name: "photos", mode: "replace", role: "data" },
    { name: "food_entries", mode: "replace", role: "data" },
    { name: "custom_foods", mode: "replace", role: "data" },
    { name: "saved_foods", mode: "replace", role: "data" },
    { name: "diary_days", mode: "replace", role: "data" },
    { name: "nutrition_targets", mode: "replace", role: "data" },
    { name: "saved_meals", mode: "replace", role: "data" },
    { name: "recipes", mode: "replace", role: "data" },
    { name: "coaching_goals", mode: "replace", role: "data" },
    { name: "check_ins", mode: "replace", role: "data" },
    {
      name: "preferences",
      mode: "keys",
      role: "settings",
      keys: {
        keyColumn: "key",
        valueColumn: "value",
        include: [
          "theme",
          "units",
          "language",
          "diaryLayout",
          "hideEmptyHours",
          "countLoggedDays",
          "installation",
          "healthInstallations",
          "weightSyncEpoch",
          "healthFoodSince",
        ],
        provenance: ["installation", "healthInstallations", "weightSyncEpoch", "healthFoodSince"],
      },
    },
    { name: "health_links", mode: "replace", role: "provenance" },
  ],
  media: [{ set: "progress-photos", directory: "progress-photos", table: "photos", column: "uri" }],
  summary: {
    entries: "SELECT count(*) AS v FROM food_entries",
    days: "SELECT count(DISTINCT day) AS v FROM food_entries",
    weights: "SELECT count(*) AS v FROM weight_entries",
    recipes: "SELECT count(*) AS v FROM recipes",
    savedMeals: "SELECT count(*) AS v FROM saved_meals",
    first: "SELECT min(day) AS v FROM food_entries",
    latest:
      "SELECT max(m) AS v FROM (SELECT day AS m FROM food_entries UNION ALL SELECT substr(measured_at, 1, 10) FROM weight_entries)",
  },
  describe: (values, ctx) => [
    ...count(ctx, "foodEntryCountOne", "foodEntryCount", values.entries),
    ...count(ctx, "weightCountOne", "weightCount", values.weights),
    ...count(ctx, "recipeCountOne", "recipeCount", values.recipes),
    ...count(ctx, "savedMealCountOne", "savedMealCount", values.savedMeals),
    ...(values.first == null
      ? []
      : [interpolate(translate(ctx.language, "sinceDay"), { day: ctx.date(values.first) })]),
  ],
  csv: async () => {
    // The builders read the live database through Drizzle; the CSVs are informational (spec §2.8).
    const { exportDiaryCsv, exportTargetsCsv, exportWeightCsv } =
      await import("@/lib/data-ownership");
    return [
      { name: "diary.csv", text: withoutBom(exportDiaryCsv()) },
      { name: "weight.csv", text: withoutBom(exportWeightCsv()) },
      { name: "targets.csv", text: withoutBom(exportTargetsCsv()) },
    ];
  },
  validate(db) {
    const issues: VaultIssue[] = [];
    const check = (table: string, message: string, condition: string, fatal = true) => {
      if (countWhere(db, table, condition) > 0) issues.push({ table, fatal, message });
    };
    // Fatal: the app parses these without guards.
    const objects: [string, string][] = [
      ["food_entries", "food"],
      ["food_entries", "nutrients"],
      ["custom_foods", "food"],
      ["saved_foods", "food"],
      ["nutrition_targets", "targets"],
      ["check_ins", "review"],
      ["check_ins", "targets"],
      ["measurements", '"values"'],
    ];
    for (const [table, column] of objects) check(table, `json:${column}`, jsonObject(column));
    check("saved_meals", "json:items", jsonArray("items"));
    check("recipes", "json:ingredients", jsonArray("ingredients"));
    check("coaching_goals", "json:program", `program IS NOT NULL AND ${jsonObject("program")}`);
    check("food_entries", "value:meal", notIn("meal", ["Breakfast", "Lunch", "Dinner", "Snacks"]));
    check(
      "diary_days",
      "value:status",
      notIn("status", ["in-progress", "complete", "partial", "fasting"])
    );
    check("coaching_goals", "value:mode", notIn("mode", ["manual", "lose", "maintain", "gain"]));
    check("check_ins", "value:decision", notIn("decision", ["accepted", "kept", "adjusted"]));
    const days: [string, string][] = [
      ["food_entries", "day"],
      ["diary_days", "day"],
      ["nutrition_targets", "effective_day"],
      ["check_ins", "day"],
      ["coaching_goals", "started_day"],
    ];
    for (const [table, column] of days) check(table, `day:${column}`, `${column} NOT GLOB ${DAY}`);
    check("measurements", "value:kind", notIn("kind", ["height", "body"]));
    check("photos", "value:pose", notIn("pose", ["front", "side", "back"]));
    if (
      db.getAllSync<{ uri: string }>("SELECT uri FROM photos").some((p) => !MEDIA_NAME.test(p.uri))
    )
      issues.push({ table: "photos", fatal: true, message: "value:uri" });
    // Not fatal: no declared foreign key; the app only compares goalId numerically.
    check("check_ins", "ref:goal_id", "goal_id NOT IN (SELECT id FROM coaching_goals)", false);
    return issues;
  },
  prepareScratch: healthPolicy,
  deviceOverrides: (ctx) => [
    ...healthOff(ctx),
    // The v1 pre-restore copy is superseded by this restore's recovery set (spec §3.9).
    { sql: "DELETE FROM preferences WHERE key = 'recoveryBackupUri'" },
  ],
  healthEnabledSql: "SELECT value = 'true' AS v FROM preferences WHERE key = 'healthSyncEnabled'",
  health: {
    clientPrefix: "macro-track",
    rowTables: {
      weight: "weight_entries",
      height: "measurements",
      waist: "measurements",
      bodyFat: "measurements",
      food: "food_entries",
    },
  },
  legacy: macroLegacy,
  hooks: {
    // Waits for a running Health sync, then holds syncs off for the restore (src/lib/health.ts).
    pauseWhenIdle: async (work, ms) => (await import("@/lib/health")).pauseWhenIdle(work, ms),
    afterRestore: async () => {
      // Health sync is off after every restore: this unregisters the daily background sync.
      await (await import("@/lib/health-schedule")).configureHealthSchedule();
    },
  },
  backgroundIntervalMinutes: 1440,
  syncIdTables: [
    "weight_entries",
    "measurements",
    "photos",
    "food_entries",
    "saved_meals",
    "coaching_goals",
  ],
  excludedTables: ["counter_logs"],
};
