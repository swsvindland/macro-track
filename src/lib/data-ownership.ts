import { sql } from "drizzle-orm";
import {
  db,
  foodEntries,
  weightEntries,
  diaryDays,
  nutritionTargets,
  customFoods,
  savedFoods,
  savedMeals,
  recipes,
  coachingGoals,
  checkIns,
  measurements,
  photos,
  counterLogs,
  healthLinks,
  preferences,
} from "@/db";

function cell(value: unknown) {
  let text = value == null ? "" : String(value);
  // Prevent user-entered names from becoming spreadsheet formulas.
  if (typeof value === "string" && /^[\s]*[=+@-]/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}
export function csv(rows: unknown[][]) {
  return "\uFEFF" + rows.map((row) => row.map(cell).join(",")).join("\r\n") + "\r\n";
}
type Row = [day: string, ...cells: unknown[]];
// A fasting day has no food; zero nutrients keep it in daily totals.
const fasted = ["", "", "", "", "", "", "", 0, 0, 0, 0, 0, 0, "fasting", "", ""];
export function exportDiaryCsv() {
  return db.transaction((tx) => {
    const entries = tx
      .select()
      .from(foodEntries)
      .orderBy(foodEntries.day, foodEntries.loggedTime, foodEntries.createdAt, foodEntries.id)
      .all();
    const days = tx.select().from(diaryDays).all();
    const statuses = new Map(days.map((row) => [row.day, row.status]));
    const logged = new Set(entries.map((row) => row.day));
    const rows: Row[] = [
      ...entries.map((row): Row => [
        row.day,
        row.meal,
        row.loggedTime,
        row.food.name,
        row.food.brand,
        row.amount,
        row.food.basis,
        row.portionLabel,
        row.nutrients.calories,
        row.nutrients.protein,
        row.nutrients.carbs,
        row.nutrients.fat,
        row.nutrients.fiber,
        row.nutrients.sodium,
        statuses.get(row.day) ?? "in-progress",
        row.food.source,
        row.food.sourceVersion,
      ]),
      ...days
        .filter((row) => row.status === "fasting" && !logged.has(row.day))
        .map((row): Row => [row.day, ...fasted]),
    ];
    // The sort is stable, so each day keeps its entries in eating order.
    rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return csv([
      [
        "date",
        "meal",
        "local_time",
        "food",
        "brand",
        "quantity",
        "basis",
        "portion",
        "calories_kcal",
        "protein_g",
        "carbs_g",
        "fat_g",
        "fiber_g",
        "sodium_mg",
        "day_status",
        "source",
        "source_version",
      ],
      ...rows,
    ]);
  });
}
export function exportWeightCsv() {
  return csv([
    ["measured_at", "weight_kg", "excluded"],
    ...db
      .select()
      .from(weightEntries)
      .orderBy(weightEntries.measuredAt)
      .all()
      .map((row) => [row.measuredAt, row.weightKg, row.excluded]),
  ]);
}
const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/**
 * A row for each day the daily budget or the goal changed: the budget from then on, the goal, and
 * its calorie shifting (higher days and how much more they get).
 */
export function exportTargetsCsv() {
  return db.transaction((tx) => {
    const targets = tx.select().from(nutritionTargets).orderBy(nutritionTargets.effectiveDay).all();
    const goals = tx.select().from(coachingGoals).orderBy(coachingGoals.id).all();
    const days = [
      ...new Set([
        ...targets.map((row) => row.effectiveDay),
        ...goals.map((row) => row.startedDay),
      ]),
    ].sort();
    return csv([
      [
        "date",
        "goal",
        "calories_kcal",
        "protein_g",
        "carbs_g",
        "fat_g",
        "higher_days",
        "higher_day_extra",
      ],
      ...days.map((day) => {
        const budget = targets.filter((row) => row.effectiveDay <= day).at(-1)?.targets,
          goal = goals.filter((row) => row.startedDay <= day).at(-1),
          shift = goal?.program?.shift;
        return [
          day,
          goal?.mode,
          budget?.calories,
          budget?.protein,
          budget?.carbs,
          budget?.fat,
          shift?.days.map((weekday) => weekdays[weekday]).join(" "),
          shift && `${shift.size}${shift.unit === "%" ? "%" : " kcal"}`,
        ];
      }),
    ]);
  });
}
// Call only while health sync is paused and after explicit UI confirmation.
export function erasePersonalRecords() {
  // Deleted rows are overwritten instead of left readable in free pages. Pragmas that return a
  // row go through `all`, which steps them to completion; VACUUM refuses to run past an open one.
  db.all(sql`PRAGMA secure_delete = ON`);
  db.transaction((tx) => {
    for (const table of [
      foodEntries,
      weightEntries,
      diaryDays,
      nutritionTargets,
      customFoods,
      savedFoods,
      savedMeals,
      recipes,
      checkIns,
      coachingGoals,
      measurements,
      photos,
      counterLogs,
      healthLinks,
      preferences,
    ])
      tx.delete(table).run();
    // A fresh namespace prevents a subsequent reconnect from overwriting old OS records.
    tx.insert(preferences)
      .values({
        key: "weightSyncEpoch",
        value: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      })
      .run();
    tx.insert(preferences).values({ key: "healthSyncEnabled", value: "false" }).run();
  });
  // The erase has committed and its rows are overwritten, so a full disk or a read left open on
  // the connection must not report it as failed from here on.
  try {
    // Rebuild the file without free pages.
    db.run(sql`VACUUM`);
  } catch (error) {
    console.warn("Could not compact the database after erasing", error);
  }
  try {
    // Move everything into the database file and empty the write-ahead log behind it.
    db.all(sql`PRAGMA wal_checkpoint(TRUNCATE)`);
  } catch (error) {
    console.warn("Could not checkpoint the database after erasing", error);
  }
}
