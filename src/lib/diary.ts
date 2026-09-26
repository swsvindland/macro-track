import { currentFoodTime, validFoodTime, inFoodGroup } from "./food-time";
import { and, desc, eq, gte, inArray, lt, lte } from "drizzle-orm";
import {
  coachingGoals,
  customFoods,
  db,
  diaryDays,
  foodEntries,
  nutritionTargets,
  savedFoods,
  savedMeals,
  recipes,
  type FoodEntry,
} from "@/db";
import { validDay } from "./metrics";
import {
  shiftDay,
  dayStates,
  recipeFood,
  type Recipe,
  meals,
  normalizeBarcode,
  scaleNutrients,
  validateFood,
  type DayState,
  type Food,
  type Meal,
  type MealItem,
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
  loggedTime,
}: {
  id?: number;
  day: string;
  meal: Meal;
  food: Food;
  amount: number;
  portionLabel: string;
  loggedTime?: string | null;
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
    const time =
      loggedTime === undefined ? (existing ? existing.loggedTime : currentFoodTime()) : loggedTime;
    if (time !== null && !validFoodTime(time))
      throw new Error("Enter a time in 24-hour format, such as 14:30.");
    const data = { day, meal, food, amount, portionLabel, nutrients, loggedTime: time };
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
  return resolveRecipeSnapshots(
    db
      .select()
      .from(savedFoods)
      .orderBy(desc(savedFoods.savedAt))
      .all()
      .map((row) => row.food)
  );
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
  return resolveRecipeSnapshots([...latest.values()]).slice(0, 20);
}

export function listSavedMeals() {
  return db
    .select()
    .from(savedMeals)
    .orderBy(desc(savedMeals.createdAt), desc(savedMeals.id))
    .all();
}

function mealItems(day: string, meal: Meal, group?: string): MealItem[] {
  if (!validDay(day) || !meals.includes(meal)) throw new Error("Choose a valid day and meal.");
  const items = entriesForDay(day).filter((entry) => inFoodGroup(entry, meal, group));
  if (!items.length) throw new Error("Add food to this meal first.");
  return items.map(({ food, amount, portionLabel, nutrients }) => ({
    food,
    amount,
    portionLabel,
    nutrients,
  }));
}

export function saveMeal(name: string, day: string, meal: Meal, group?: string) {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 80)
    throw new Error("Give your meal a name up to 80 characters.");
  return db
    .insert(savedMeals)
    .values({ name: trimmed, items: mealItems(day, meal, group), createdAt: Date.now() })
    .returning()
    .get();
}

export function deleteSavedMeal(id: number) {
  db.delete(savedMeals).where(eq(savedMeals.id, id)).run();
}

function addMealItems(
  items: MealItem[],
  day: string,
  meal: Meal,
  multiplier: number,
  loggedTime = currentFoodTime()
) {
  if (!validDay(day) || !meals.includes(meal))
    throw new Error("Choose today or an earlier date and a meal.");
  if (!Number.isFinite(multiplier) || multiplier <= 0 || multiplier > 100)
    throw new Error("Enter a meal quantity above 0 and no greater than 100.");
  if (!items.length) throw new Error("This meal has no food.");
  if (!validFoodTime(loggedTime)) throw new Error("Enter a time in 24-hour format, such as 14:30.");
  // Validate the whole batch before writing. Keep the original food and nutrient
  // snapshots, even when the catalog or personal food has since changed.
  const entries = items.map((item) => {
    validateFood(item.food);
    const amount = item.amount * multiplier;
    scaleNutrients(item.food, amount);
    const nutrients = Object.fromEntries(
      Object.entries(item.nutrients).map(([key, value]) => [
        key,
        value === null ? null : value * multiplier,
      ])
    ) as MealItem["nutrients"];
    return {
      food: item.food,
      amount,
      nutrients,
      day,
      meal,
      createdAt: Date.now(),
      loggedTime,
      portionLabel:
        multiplier === 1
          ? item.portionLabel
          : `${Number(amount.toFixed(4))} ${item.food.basis === "serving" ? "serving(s)" : item.food.basis}`,
    };
  });
  db.transaction((tx) => {
    for (const entry of entries) tx.insert(foodEntries).values(entry).run();
    const previous = tx.select().from(diaryDays).where(eq(diaryDays.day, day)).get();
    const status = previous?.status === "partial" ? "partial" : "in-progress";
    tx.insert(diaryDays)
      .values({ day, status })
      .onConflictDoUpdate({ target: diaryDays.day, set: { status } })
      .run();
  });
  return entries.length;
}

export function copyMeal(
  sourceDay: string,
  sourceMeal: Meal,
  day: string,
  meal: Meal,
  loggedTime = currentFoodTime(),
  sourceGroup?: string
) {
  return addMealItems(mealItems(sourceDay, sourceMeal, sourceGroup), day, meal, 1, loggedTime);
}

export function logSavedMeal(
  id: number,
  day: string,
  meal: Meal,
  multiplier = 1,
  loggedTime = currentFoodTime()
) {
  const saved = db.select().from(savedMeals).where(eq(savedMeals.id, id)).get();
  if (!saved) throw new Error("This saved meal no longer exists.");
  return addMealItems(saved.items, day, meal, multiplier, loggedTime);
}

export function listRecipes(): Recipe[] {
  return db.select().from(recipes).orderBy(recipes.name).all();
}

export function recipeFoods(): Food[] {
  return listRecipes().map(recipeFood);
}

export function saveRecipe(input: Omit<Recipe, "id" | "revision"> & { id?: string }): Recipe {
  return db.transaction((tx) => {
    const previous = input.id
      ? tx.select().from(recipes).where(eq(recipes.id, input.id)).get()
      : null;
    if (input.id && !previous) throw new Error("This recipe no longer exists.");
    const recipe: Recipe = {
      ...input,
      name: input.name.trim(),
      id: input.id ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      revision: (previous?.revision ?? 0) + 1,
    };
    recipeFood(recipe);
    tx.insert(recipes).values(recipe).onConflictDoUpdate({ target: recipes.id, set: recipe }).run();
    return recipe;
  });
}

export function deleteRecipe(id: string) {
  db.delete(recipes).where(eq(recipes.id, id)).run();
}

function resolveRecipeSnapshots(foods: Food[]): Food[] {
  if (!foods.some((food) => food.source === "recipe")) return foods;
  const current = new Map(recipeFoods().map((food) => [food.id, food]));
  return foods.flatMap((food) =>
    food.source === "recipe" ? (current.has(food.id) ? [current.get(food.id)!] : []) : [food]
  );
}

export function copyDay(sourceDay: string, destination: string) {
  if (!validDay(sourceDay) || !validDay(destination) || sourceDay === destination)
    throw new Error("Choose two different dates, today or earlier.");
  const entries = entriesForDay(sourceDay);
  if (!entries.length) throw new Error("There is no food to copy on that day.");
  db.transaction((tx) => {
    for (const { id: _id, ...entry } of entries)
      tx.insert(foodEntries)
        .values({ ...entry, day: destination, createdAt: Date.now() })
        .run();
    const previous = tx.select().from(diaryDays).where(eq(diaryDays.day, destination)).get();
    const status = previous?.status === "partial" ? "partial" : "in-progress";
    tx.insert(diaryDays)
      .values({ day: destination, status })
      .onConflictDoUpdate({ target: diaryDays.day, set: { status } })
      .run();
  });
  return entries.length;
}

type TimedCalories = { loggedTime: string; calories: number }[];
/**
 * Up to 14 recent complete days from the previous 28, read once so the clock can
 * move the cutoff without touching the database. Only days logged in real time
 * count. Untimed legacy entries and back-filled days (anything created after 04:00
 * the next morning) carry the logging clock rather than the meal time, which would
 * make the evening look emptier than it is.
 */
export function typicalDays(day: string): TimedCalories[] {
  const complete = db
    .select({ day: diaryDays.day })
    .from(diaryDays)
    .where(
      and(
        eq(diaryDays.status, "complete"),
        gte(diaryDays.day, shiftDay(day, -28)),
        lt(diaryDays.day, day)
      )
    )
    .orderBy(desc(diaryDays.day))
    .all()
    .map((row) => row.day);
  if (complete.length < 3) return [];
  const rows = db
    .select({
      day: foodEntries.day,
      loggedTime: foodEntries.loggedTime,
      createdAt: foodEntries.createdAt,
      nutrients: foodEntries.nutrients,
    })
    .from(foodEntries)
    .where(inArray(foodEntries.day, complete))
    .all();
  const days: TimedCalories[] = [];
  for (const date of complete) {
    const entries = rows.filter((row) => row.day === date);
    const lateCutoff = new Date(`${shiftDay(date, 1)}T04:00:00`).getTime();
    if (!entries.length || entries.some((row) => !row.loggedTime || row.createdAt > lateCutoff))
      continue;
    days.push(
      entries.map((row) => ({ loggedTime: row.loggedTime!, calories: row.nutrients.calories }))
    );
    if (days.length === 14) break;
  }
  return days;
}

/** Median calories logged after `cutoff` ("HH:MM") across `days`, or null under 3 days. */
export function typicalAfter(days: TimedCalories[], cutoff: string): number | null {
  if (days.length < 3) return null;
  const samples = days
    .map((rows) =>
      rows.filter((row) => row.loggedTime > cutoff).reduce((sum, row) => sum + row.calories, 0)
    )
    .sort((a, b) => a - b);
  const middle = Math.floor(samples.length / 2);
  return samples.length % 2 ? samples[middle] : (samples[middle - 1] + samples[middle]) / 2;
}

/**
 * The most recent of the last 7 days (21 while coached) that has food and targets but was never
 * marked complete or partial. Coaching only learns from answered days, so Home
 * asks about one at a time.
 */
export function dayToConfirm(today: string): { day: string; calories: number } | null {
  const open = db
    .select({ day: diaryDays.day })
    .from(diaryDays)
    .where(
      and(
        eq(diaryDays.status, "in-progress"),
        gte(diaryDays.day, shiftDay(today, isCoached() ? -21 : -7)),
        lt(diaryDays.day, today)
      )
    )
    .orderBy(desc(diaryDays.day))
    .all();
  for (const { day } of open) {
    const entries = entriesForDay(day);
    if (entries.length && targetsForDay(day))
      return { day, calories: entries.reduce((sum, row) => sum + row.nutrients.calories, 0) };
  }
  return null;
}

/** Whether a Cut/Bulk/Maintain program is running (manual targets don't check in). */
export function isCoached() {
  const goal = db.select().from(coachingGoals).orderBy(desc(coachingGoals.id)).limit(1).get();
  return !!goal && goal.mode !== "manual";
}
