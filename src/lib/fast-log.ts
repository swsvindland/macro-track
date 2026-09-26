import { desc, eq } from "drizzle-orm";
import { db, diaryDays, foodEntries, type FoodEntry } from "@/db";
import { entriesForDay, favoriteFoods, listSavedMeals, personalFoods, recipeFoods } from "./diary";
import { currentFoodTime, mealAtTime, normalizeFoodTime, validFoodTime } from "./food-time";
import { localDay, validDay } from "./metrics";
import { scaleNutrients, validateFood, type Food, type Meal, type MealItem } from "./nutrition";

export type LogChoice = { key: string; title: string; detail: string; items: MealItem[] };
export type LogReceipt = {
  day: string;
  entries: FoodEntry[];
  before: string;
  beforeStatus: string | null;
  afterStatus: string;
};
export function portionFor(food: Food, recent?: FoodEntry): MealItem {
  const reuse =
    recent?.food.basis === food.basis &&
    (food.source !== "recipe" || recent.food.sourceVersion === food.sourceVersion);
  const amount = reuse
    ? recent!.amount
    : (food.portions[0]?.amount ?? (food.basis === "serving" ? 1 : 100));
  return {
    food,
    amount,
    portionLabel: reuse
      ? recent!.portionLabel
      : food.portions[0]?.label
        ? `${food.portions[0].label} · ${amount} ${food.basis}`
        : `${amount} ${food.basis === "serving" ? "serving" : food.basis}`,
    nutrients: scaleNutrients(food, amount),
  };
}
export function loggingChoices(time = currentFoodTime()) {
  const history = db
    .select()
    .from(foodEntries)
    .orderBy(desc(foodEntries.createdAt), desc(foodEntries.id))
    .limit(200)
    .all();
  const current = new Map([...personalFoods(), ...recipeFoods()].map((food) => [food.id, food]));
  const favorites = favoriteFoods();
  const recent = new Map<string, FoodEntry>();
  for (const entry of history) if (!recent.has(entry.food.id)) recent.set(entry.food.id, entry);
  const hour = Number((normalizeFoodTime(time) ?? currentFoodTime()).slice(0, 2));
  const distance = (row: FoodEntry | undefined) => {
    if (!row) return 24;
    const h = row.loggedTime ? Number(row.loggedTime.slice(0, 2)) : hour + 6;
    const d = Math.abs(hour - h);
    return Math.min(d, 24 - d);
  };
  // Quick-add estimates are one-offs, not foods to pick again.
  const ranked = [...recent.values()]
    .filter((row) => !row.food.id.startsWith("quick:"))
    .filter((row) => row.food.source !== "recipe" || current.has(row.food.id))
    .sort((a, b) => distance(a) - distance(b) || b.createdAt - a.createdAt || b.id - a.id);
  const foods = [
    ...new Map(
      [
        ...ranked.map((row) => current.get(row.food.id) ?? row.food),
        ...favorites,
        ...current.values(),
      ].map((food) => [food.id, food])
    ).values(),
  ];
  const choices = foods.map((food) => {
    const item = portionFor(food, recent.get(food.id));
    return { key: `food:${food.id}`, title: food.name, detail: item.portionLabel, items: [item] };
  });
  // Saved meals whose foods are usually eaten around this hour come first.
  const saved = listSavedMeals()
    .map((meal) => ({
      meal,
      distance: Math.min(...meal.items.map((item) => distance(recent.get(item.food.id)))),
    }))
    .sort((a, b) => a.distance - b.distance);
  const meals: LogChoice[] = saved.map(({ meal }) => ({
    key: `meal:${meal.id}`,
    title: meal.name,
    detail: `${meal.items.length} foods · saved meal`,
    items: meal.items,
  }));
  return { choices, meals, history, personal: [...current.values()] };
}

export function logBatch(
  items: MealItem[],
  options: { day?: string; time?: string; meal?: Meal; complete?: boolean } = {}
): LogReceipt {
  const day = options.day ?? localDay(),
    time = options.time ?? currentFoodTime();
  if (!validDay(day) || !validFoodTime(time)) throw new Error("Choose a valid date and time.");
  if (!items.length || items.length > 200) throw new Error("Choose between 1 and 200 foods.");
  for (const item of items) {
    validateFood(item.food);
    scaleNutrients(item.food, item.amount);
    if (
      !item.portionLabel.trim() ||
      Object.values(item.nutrients).some(
        (n) => n !== null && (!Number.isFinite(n) || n < 0 || n > 1e12)
      )
    )
      throw new Error("Check the quantities in this meal.");
  }
  return db.transaction((tx) => {
    const before = JSON.stringify(entriesForDay(day));
    const previous = tx.select().from(diaryDays).where(eq(diaryDays.day, day)).get();
    const afterStatus = options.complete
      ? "complete"
      : previous?.status === "partial"
        ? "partial"
        : "in-progress";
    const entries = items.map((item) =>
      tx
        .insert(foodEntries)
        .values({
          ...item,
          day,
          meal: options.meal ?? mealAtTime(time),
          loggedTime: time,
          createdAt: Date.now(),
        })
        .returning()
        .get()
    );
    tx.insert(diaryDays)
      .values({ day, status: afterStatus })
      .onConflictDoUpdate({ target: diaryDays.day, set: { status: afterStatus } })
      .run();
    return { day, entries, before, beforeStatus: previous?.status ?? null, afterStatus };
  });
}
export function undoLog(receipt: LogReceipt) {
  db.transaction((tx) => {
    const existing = entriesForDay(receipt.day);
    if (
      receipt.entries.some(
        (entry) =>
          JSON.stringify(existing.find((row) => row.id === entry.id)) !== JSON.stringify(entry)
      )
    )
      throw new Error("This log has changed. Edit it in your timeline instead.");
    for (const entry of receipt.entries)
      tx.delete(foodEntries).where(eq(foodEntries.id, entry.id)).run();
    const remaining = entriesForDay(receipt.day);
    const status = tx.select().from(diaryDays).where(eq(diaryDays.day, receipt.day)).get()?.status;
    if (JSON.stringify(remaining) === receipt.before && status === receipt.afterStatus) {
      if (receipt.beforeStatus === null)
        tx.delete(diaryDays).where(eq(diaryDays.day, receipt.day)).run();
      else
        tx.update(diaryDays)
          .set({
            status: receipt.beforeStatus as "complete" | "partial" | "fasting" | "in-progress",
          })
          .where(eq(diaryDays.day, receipt.day))
          .run();
    } else if (!remaining.length && status === "complete")
      tx.update(diaryDays)
        .set({ status: "in-progress" })
        .where(eq(diaryDays.day, receipt.day))
        .run();
  });
}
