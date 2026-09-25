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
export function exportDiaryCsv() {
  return db.transaction((tx) => {
    const entries = tx
      .select()
      .from(foodEntries)
      .orderBy(foodEntries.day, foodEntries.createdAt)
      .all();
    const statuses = new Map(
      tx
        .select()
        .from(diaryDays)
        .all()
        .map((row) => [row.day, row.status])
    );
    return csv([
      [
        "date",
        "meal",
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
      ...entries.map((row) => [
        row.day,
        row.meal,
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
    ]);
  });
}
export function exportWeightCsv() {
  return csv([
    ["measured_at", "weight_kg"],
    ...db
      .select()
      .from(weightEntries)
      .orderBy(weightEntries.measuredAt)
      .all()
      .map((row) => [row.measuredAt, row.weightKg]),
  ]);
}
// Call only while health sync is paused and after explicit UI confirmation.
export function erasePersonalRecords() {
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
}
