import { currentFoodTime, validFoodTime, inFoodGroup, mealAtTime } from "./food-time";
import { and, desc, eq, gte, inArray, lt, lte } from "drizzle-orm";
import {
  coachingGoals,
  customFoods,
  db,
  diaryDays,
  foodEntries,
  nutritionTargets,
  preferences,
  savedFoods,
  savedMeals,
  recipes,
  type FoodEntry,
} from "@/db";
import { localDay, validDay } from "./metrics";
import {
  shiftDay,
  dayStates,
  recipeFood,
  type Recipe,
  meals,
  barcodeCandidates,
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
  db.transaction((tx) => {
    tx.insert(diaryDays)
      .values({ day, status })
      .onConflictDoUpdate({ target: diaryDays.day, set: { status } })
      .run();
    // Any answer about yesterday, "In progress" included, is never counted over.
    if (day === shiftDay(localDay(), -1)) settle(tx, day);
  });
}
/** What a diary write changed, so Undo can put exactly that back. */
export type DiaryReceipt = {
  inserted: FoodEntry[];
  deleted: FoodEntry[];
  moved: { before: FoodEntry; after: FoodEntry }[];
  /** Each day the write touched: its status before and after, and its rows right after. */
  days: Record<string, { before: DayState | null; after: DayState; rows: string }>;
};
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** Yesterday was counted or answered, so `countableDay` leaves it alone. */
function settle(tx: Transaction, day: string) {
  tx.insert(preferences)
    .values({ key: "settledDay", value: day })
    .onConflictDoUpdate({ target: preferences.key, set: { value: day } })
    .run();
}

/**
 * Reopens each day a write touched, keeping a day answered "partial" as it is, and
 * records what Undo needs. Runs last in the write's transaction.
 */
export function touchDays(
  tx: Transaction,
  days: string[],
  status?: DayState
): DiaryReceipt["days"] {
  const touched: DiaryReceipt["days"] = {};
  for (const day of new Set(days)) {
    const before = tx.select().from(diaryDays).where(eq(diaryDays.day, day)).get()?.status ?? null;
    const after = status ?? (before === "partial" ? "partial" : "in-progress");
    tx.insert(diaryDays)
      .values({ day, status: after })
      .onConflictDoUpdate({ target: diaryDays.day, set: { status: after } })
      .run();
    touched[day] = { before, after, rows: JSON.stringify(entriesForDay(day)) };
  }
  return touched;
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
}): DiaryReceipt {
  if (!validDay(day)) throw new Error("Choose today or an earlier date.");
  if (!meals.includes(meal)) throw new Error("Choose a meal.");
  validateFood(food);
  const nutrients = scaleNutrients(food, amount);
  if (!portionLabel.trim()) throw new Error("Choose a serving.");
  return db.transaction((tx) => {
    const existing =
      id === undefined ? null : tx.select().from(foodEntries).where(eq(foodEntries.id, id)).get();
    if (id !== undefined && !existing) throw new Error("This entry no longer exists.");
    const time =
      loggedTime === undefined ? (existing ? existing.loggedTime : currentFoodTime()) : loggedTime;
    if (time !== null && !validFoodTime(time))
      throw new Error("Enter a time such as 9:30 or 21:30.");
    const data = { day, meal, food, amount, portionLabel, nutrients, loggedTime: time };
    if (!existing) {
      const row = tx
        .insert(foodEntries)
        .values({ ...data, createdAt: Date.now() })
        .returning()
        .get();
      return { inserted: [row], deleted: [], moved: [], days: touchDays(tx, [day]) };
    }
    const row = tx
      .update(foodEntries)
      .set(data)
      .where(eq(foodEntries.id, existing.id))
      .returning()
      .get();
    return {
      inserted: [],
      deleted: [],
      moved: [{ before: existing, after: row }],
      days: touchDays(tx, [day, existing.day]),
    };
  });
}

/** The chosen entries, oldest first, or an error when any of them is gone. */
function chosenEntries(tx: Transaction, ids: number[]) {
  const rows = ids.length
    ? tx
        .select()
        .from(foodEntries)
        .where(inArray(foodEntries.id, ids))
        .orderBy(foodEntries.createdAt, foodEntries.id)
        .all()
    : [];
  if (!rows.length || rows.length !== new Set(ids).size)
    throw new Error("Some of these foods are no longer in your diary.");
  return rows;
}
function checkDestination(day: string, time: string | null, meal?: Meal | null) {
  if (!validDay(day)) throw new Error("Choose today or an earlier date.");
  if (time !== null && !validFoodTime(time)) throw new Error("Enter a time such as 9:30 or 21:30.");
  if (meal != null && !meals.includes(meal)) throw new Error("Choose a meal.");
}
/**
 * A new time sets the meal too, unless one is given or `meal` is null; no time, or a
 * null meal, keeps each entry's own.
 */
function placed(row: FoodEntry, day: string, time: string | null, meal?: Meal | null) {
  return {
    day,
    loggedTime: time ?? row.loggedTime,
    meal: meal === null ? row.meal : (meal ?? (time ? mealAtTime(time) : row.meal)),
  };
}

export function deleteEntries(ids: number[]): DiaryReceipt {
  return db.transaction((tx) => {
    const rows = chosenEntries(tx, ids);
    tx.delete(foodEntries).where(inArray(foodEntries.id, ids)).run();
    const days = touchDays(
      tx,
      rows.map((row) => row.day)
    );
    return { inserted: [], deleted: rows, moved: [], days };
  });
}
export function deleteEntry(entry: FoodEntry) {
  return deleteEntries([entry.id]);
}

/** Moves entries to another day and, unless `time` is null, to one new time. */
export function moveEntries(
  ids: number[],
  day: string,
  time: string | null,
  meal?: Meal | null
): DiaryReceipt {
  checkDestination(day, time, meal);
  return db.transaction((tx) => {
    const rows = chosenEntries(tx, ids).filter((row) => {
      const next = placed(row, day, time, meal);
      return next.day !== row.day || next.loggedTime !== row.loggedTime || next.meal !== row.meal;
    });
    if (!rows.length) throw new Error("Choose a different day or time.");
    const moved = rows.map((before) => ({
      before,
      after: tx
        .update(foodEntries)
        .set(placed(before, day, time, meal))
        .where(eq(foodEntries.id, before.id))
        .returning()
        .get(),
    }));
    const days = touchDays(tx, [...rows.map((row) => row.day), day]);
    return { inserted: [], deleted: [], moved, days };
  });
}

/** Logs entries again on `day`, at one `time` or, when it is null, at their own times. */
export function copyEntries(
  ids: number[],
  day: string,
  time: string | null,
  meal?: Meal | null
): DiaryReceipt {
  checkDestination(day, time, meal);
  return db.transaction((tx) => {
    const inserted = chosenEntries(tx, ids).map((row) => {
      const { id: _id, ...copy } = row;
      return tx
        .insert(foodEntries)
        .values({ ...copy, ...placed(row, day, time, meal), createdAt: Date.now() })
        .returning()
        .get();
    });
    return { inserted, deleted: [], moved: [], days: touchDays(tx, [day]) };
  });
}

/**
 * Puts back what a write changed: rows it added go, rows it deleted return with their
 * ids and creation times, and moved rows go back where they were. Refuses when any of
 * those rows changed since. Each day's status goes back too, unless the day changed
 * since; then it keeps its current answer while that still fits the day's food.
 */
export function undoReceipt(receipt: DiaryReceipt) {
  db.transaction((tx) => {
    const current = (id: number) =>
      tx.select().from(foodEntries).where(eq(foodEntries.id, id)).get();
    const status = (day: string) =>
      tx.select().from(diaryDays).where(eq(diaryDays.day, day)).get()?.status;
    const same = (row: FoodEntry | undefined, entry: FoodEntry) =>
      JSON.stringify(row) === JSON.stringify(entry);
    if (
      receipt.inserted.some((entry) => !same(current(entry.id), entry)) ||
      receipt.moved.some(({ after }) => !same(current(after.id), after)) ||
      receipt.deleted.some((entry) => current(entry.id))
    )
      throw new Error("This has changed since. Edit it in your diary instead.");
    const days = Object.entries(receipt.days).map(([day, state]) => ({
      day,
      state,
      untouched: status(day) === state.after && JSON.stringify(entriesForDay(day)) === state.rows,
    }));
    for (const entry of receipt.inserted)
      tx.delete(foodEntries).where(eq(foodEntries.id, entry.id)).run();
    for (const entry of receipt.deleted) tx.insert(foodEntries).values(entry).run();
    for (const { before } of receipt.moved) {
      const { id, ...row } = before;
      tx.update(foodEntries).set(row).where(eq(foodEntries.id, id)).run();
    }
    for (const { day, state, untouched } of days) {
      const now = status(day),
        count = entriesForDay(day).length;
      if (untouched && state.before)
        tx.update(diaryDays).set({ status: state.before }).where(eq(diaryDays.day, day)).run();
      else if (untouched) tx.delete(diaryDays).where(eq(diaryDays.day, day)).run();
      else if ((now === "complete" && !count) || (now === "fasting" && count))
        tx.update(diaryDays).set({ status: "in-progress" }).where(eq(diaryDays.day, day)).run();
    }
  });
}
/** An edit keeps the entry's label, including an "≈" estimate, unless its amount or basis changed. */
export function editedPortionLabel(entry: FoodEntry | undefined, food: Food, amount: number) {
  return entry && entry.amount === amount && entry.food.basis === food.basis
    ? entry.portionLabel
    : `${amount} ${food.basis === "serving" ? "serving(s)" : food.basis}`;
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
export function findPersonalBarcode(barcode: string, symbology?: string): Food | null {
  const codes = barcodeCandidates(barcode, symbology);
  if (!codes.length) return null;
  const rows = db.select().from(customFoods).where(inArray(customFoods.barcode, codes)).all();
  return codes.map((code) => rows.find((row) => row.barcode === code)).find(Boolean)?.food ?? null;
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

/** A meal or hour group's entries, or with `ids`, just those entries of the day. */
function mealItems(day: string, meal: Meal, group?: string, ids?: number[]): MealItem[] {
  if (!validDay(day) || !meals.includes(meal)) throw new Error("Choose a valid day and meal.");
  const items = entriesForDay(day).filter((entry) =>
    ids ? ids.includes(entry.id) : inFoodGroup(entry, meal, group)
  );
  if (!items.length) throw new Error("Add food to this meal first.");
  return items.map(({ food, amount, portionLabel, nutrients }) => ({
    food,
    amount,
    portionLabel,
    nutrients,
  }));
}

export function saveMeal(name: string, day: string, meal: Meal, group?: string, ids?: number[]) {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 80)
    throw new Error("Give your meal a name up to 80 characters.");
  return db
    .insert(savedMeals)
    .values({ name: trimmed, items: mealItems(day, meal, group, ids), createdAt: Date.now() })
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
): DiaryReceipt {
  if (!validDay(day) || !meals.includes(meal))
    throw new Error("Choose today or an earlier date and a meal.");
  if (!Number.isFinite(multiplier) || multiplier <= 0 || multiplier > 100)
    throw new Error("Enter a meal quantity above 0 and no greater than 100.");
  if (!items.length) throw new Error("This meal has no food.");
  if (!validFoodTime(loggedTime)) throw new Error("Enter a time such as 9:30 or 21:30.");
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
  return db.transaction((tx) => {
    const inserted = entries.map((entry) => tx.insert(foodEntries).values(entry).returning().get());
    return { inserted, deleted: [], moved: [], days: touchDays(tx, [day]) };
  });
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

export function copyDay(sourceDay: string, destination: string): DiaryReceipt {
  if (!validDay(sourceDay) || !validDay(destination) || sourceDay === destination)
    throw new Error("Choose two different dates, today or earlier.");
  const entries = entriesForDay(sourceDay);
  if (!entries.length) throw new Error("There is no food to copy on that day.");
  return db.transaction((tx) => {
    const inserted = entries.map(({ id: _id, ...entry }) =>
      tx
        .insert(foodEntries)
        .values({ ...entry, day: destination, createdAt: Date.now() })
        .returning()
        .get()
    );
    return { inserted, deleted: [], moved: [], days: touchDays(tx, [destination]) };
  });
}

type TimedCalories = { loggedTime: string; calories: number }[];
/** Logged in real time: every entry has a time and was created by 04:00 the next morning. */
function loggedLive(day: string, rows: { loggedTime: string | null; createdAt: number }[]) {
  const cutoff = new Date(`${shiftDay(day, 1)}T04:00:00`).getTime();
  return rows.every((row) => row.loggedTime && row.createdAt <= cutoff);
}
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
    if (!entries.length || !loggedLive(date, entries)) continue;
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
 * The most recent of the last 7 days that has food and targets but was never
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
        gte(diaryDays.day, shiftDay(today, -7)),
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

const preference = (key: string) =>
  db.select().from(preferences).where(eq(preferences.key, key)).get()?.value;
/**
 * Yesterday, when it can count as complete without asking: it is after 04:00, the
 * setting is on, the day still waits for an answer, and it was clearly logged in full,
 * with 3 or more entries logged in real time reaching 70% of its target. A day is
 * counted once, so after Undo Home asks about it instead, and never after an answer.
 */
export function countableDay(now = new Date()): string | null {
  const day = shiftDay(localDay(now), -1);
  if (
    now.getHours() < 4 ||
    preference("countLoggedDays") === "false" ||
    preference("settledDay") === day ||
    dayStatus(day) !== "in-progress"
  )
    return null;
  const entries = entriesForDay(day),
    target = targetsForDay(day)?.calories;
  const calories = entries.reduce((sum, row) => sum + row.nutrients.calories, 0);
  return target && entries.length >= 3 && loggedLive(day, entries) && calories >= target * 0.7
    ? day
    : null;
}
/** Marks the `countableDay` complete, returning what Undo needs, or null when there is none. */
export function countLoggedDay(now = new Date()): DiaryReceipt | null {
  return db.transaction((tx) => {
    const day = countableDay(now);
    if (!day) return null;
    settle(tx, day);
    return { inserted: [], deleted: [], moved: [], days: touchDays(tx, [day], "complete") };
  });
}

/** Whether a Cut/Bulk/Maintain program is running (manual targets don't check in). */
export function isCoached() {
  const goal = db.select().from(coachingGoals).orderBy(desc(coachingGoals.id)).limit(1).get();
  return !!goal && goal.mode !== "manual";
}
