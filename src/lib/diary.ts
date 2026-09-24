import { desc, eq, lte } from "drizzle-orm";
import {
  customFoods,
  db,
  diaryDays,
  foodEntries,
  nutritionTargets,
  savedFoods,
  type FoodEntry,
} from "@/db";
import { validDay } from "./metrics";
import {
  dayStates,
  meals,
  normalizeBarcode,
  scaleNutrients,
  validateFood,
  type DayState,
  type Food,
  type Meal,
  type Targets,
} from "./nutrition";

export function entriesForDay(day: string): FoodEntry[] {
  return db
    .select()
    .from(foodEntries)
    .where(eq(foodEntries.day, day))
    .orderBy(foodEntries.createdAt, foodEntries.id)
    .all();
}
export function targetsForDay(day: string): Targets | null {
  return (
    db
      .select()
      .from(nutritionTargets)
      .where(lte(nutritionTargets.effectiveDay, day))
      .orderBy(desc(nutritionTargets.effectiveDay))
      .limit(1)
      .get()?.targets ?? null
  );
}
export function dayStatus(day: string) {
  return db.select().from(diaryDays).where(eq(diaryDays.day, day)).get()?.status ?? "in-progress";
}
export function setDayStatus(day: string, status: DayState) {
  if (!validDay(day) || !dayStates.includes(status))
    throw new Error("Choose a valid day and status.");
  if (status === "fasting" && entriesForDay(day).length)
    throw new Error("A fasting day cannot contain food entries.");
  if (status === "complete" && !entriesForDay(day).length)
    throw new Error("Log your food first, or mark this as a fasting day.");
  db.insert(diaryDays)
    .values({ day, status })
    .onConflictDoUpdate({ target: diaryDays.day, set: { status } })
    .run();
}
export function saveEntry({
  id,
  day,
  meal,
  food,
  amount,
  portionLabel,
}: {
  id?: number;
  day: string;
  meal: Meal;
  food: Food;
  amount: number;
  portionLabel: string;
}) {
  if (!validDay(day)) throw new Error("Choose today or an earlier date.");
  if (!meals.includes(meal)) throw new Error("Choose a meal.");
  validateFood(food);
  const nutrients = scaleNutrients(food, amount);
  if (!portionLabel.trim()) throw new Error("Choose a serving.");
  db.transaction((tx) => {
    const existing =
      id === undefined ? null : tx.select().from(foodEntries).where(eq(foodEntries.id, id)).get();
    if (id !== undefined && !existing) throw new Error("This entry no longer exists.");
    const data = { day, meal, food, amount, portionLabel, nutrients };
    if (id === undefined)
      tx.insert(foodEntries)
        .values({ ...data, createdAt: Date.now() })
        .run();
    else tx.update(foodEntries).set(data).where(eq(foodEntries.id, id)).run();
    for (const affectedDay of new Set([day, existing?.day].filter((d): d is string => !!d))) {
      const previous = tx.select().from(diaryDays).where(eq(diaryDays.day, affectedDay)).get();
      const status = previous?.status === "partial" ? "partial" : "in-progress";
      tx.insert(diaryDays)
        .values({ day: affectedDay, status })
        .onConflictDoUpdate({ target: diaryDays.day, set: { status } })
        .run();
    }
  });
}
export function deleteEntry(entry: FoodEntry) {
  db.transaction((tx) => {
    tx.delete(foodEntries).where(eq(foodEntries.id, entry.id)).run();
    tx.insert(diaryDays)
      .values({ day: entry.day, status: "in-progress" })
      .onConflictDoUpdate({ target: diaryDays.day, set: { status: "in-progress" } })
      .run();
  });
}
export function saveTargets(day: string, targets: Targets) {
  if (!validDay(day)) throw new Error("Choose a valid starting date.");
  if (
    !Number.isFinite(targets.calories) ||
    targets.calories <= 0 ||
    targets.calories > 10000 ||
    [targets.protein, targets.carbs, targets.fat].some(
      (n) => !Number.isFinite(n) || n < 0 || n > 1500
    )
  ) {
    throw new Error("Enter positive calories and valid macro targets.");
  }
  db.insert(nutritionTargets)
    .values({ effectiveDay: day, targets })
    .onConflictDoUpdate({ target: nutritionTargets.effectiveDay, set: { targets } })
    .run();
}
export function saveCustomFood(food: Food) {
  validateFood(food);
  if (food.source !== "custom") throw new Error("Only personal foods can be changed.");
  const barcode = food.barcode ? normalizeBarcode(food.barcode) : null;
  const data = {
    id: food.id,
    name: food.name.trim(),
    barcode,
    food: { ...food, barcode, name: food.name.trim() },
  };
  db.insert(customFoods)
    .values(data)
    .onConflictDoUpdate({ target: customFoods.id, set: data })
    .run();
}
export function personalFoods(): Food[] {
  return db
    .select()
    .from(customFoods)
    .orderBy(customFoods.name)
    .all()
    .map((row) => row.food);
}
export function findPersonalBarcode(barcode: string): Food | null {
  const code = normalizeBarcode(barcode);
  return code
    ? (db.select().from(customFoods).where(eq(customFoods.barcode, code)).get()?.food ?? null)
    : null;
}
export function favoriteFoods(): Food[] {
  return db
    .select()
    .from(savedFoods)
    .orderBy(desc(savedFoods.savedAt))
    .all()
    .map((row) => row.food);
}
export function toggleFavorite(food: Food) {
  if (db.select().from(savedFoods).where(eq(savedFoods.id, food.id)).get())
    db.delete(savedFoods).where(eq(savedFoods.id, food.id)).run();
  else db.insert(savedFoods).values({ id: food.id, food, savedAt: Date.now() }).run();
}
export function recentFoods(): Food[] {
  const rows = db
    .select()
    .from(foodEntries)
    .orderBy(desc(foodEntries.createdAt), desc(foodEntries.id))
    .limit(100)
    .all();
  const latest = new Map<string, Food>();
  for (const row of rows) if (!latest.has(row.food.id)) latest.set(row.food.id, row.food);
  return [...latest.values()].slice(0, 20);
}
