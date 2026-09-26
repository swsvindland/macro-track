import { desc } from "drizzle-orm";
import { db, foodEntries, type FoodEntry } from "@/db";
import {
  favoriteFoods,
  listSavedMeals,
  personalFoods,
  recipeFoods,
  touchDays,
  undoReceipt,
  type DiaryReceipt,
} from "./diary";
import { currentFoodTime, mealAtTime, normalizeFoodTime, validFoodTime } from "./food-time";
import { localDay, validDay } from "./metrics";
import { scaleNutrients, validateFood, type Food, type Meal, type MealItem } from "./nutrition";

export type LogChoice = { key: string; title: string; detail: string; items: MealItem[] };
/** A batch log's receipt; `entries` are its new rows, all on `day`. */
export type LogReceipt = DiaryReceipt & { day: string; entries: FoodEntry[] };
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
    const inserted = items.map((item) =>
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
    const days = touchDays(tx, [day], options.complete ? "complete" : undefined);
    return { day, entries: inserted, inserted, deleted: [], moved: [], days };
  });
}
/** A log undoes like any other diary write. */
export const undoLog = undoReceipt;
