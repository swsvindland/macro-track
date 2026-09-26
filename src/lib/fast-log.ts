import { gte, inArray, sql } from "drizzle-orm";
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
import type { Named } from "./food-rank";
import {
  clockMinutes,
  currentFoodTime,
  mealAtTime,
  normalizeFoodTime,
  validFoodTime,
} from "./food-time";
import { localDay, validDay } from "./metrics";
import {
  defaultPortion,
  portionItem,
  portionOf,
  scaleNutrients,
  validateFood,
  type Food,
  type Meal,
  type MealItem,
} from "./nutrition";

export type LogChoice = { key: string; title: string; detail: string; items: MealItem[] };
/** A batch log's receipt; `entries` are its new rows, all on `day`. */
export type LogReceipt = DiaryReceipt & { day: string; entries: FoodEntry[] };
/**
 * A food's portion for "Log again": the unit and count it was last logged in, while the food
 * still has that unit, else its usual portion.
 */
export function portionFor(food: Food, recent?: FoodEntry): MealItem {
  const reuse =
    recent?.food.basis === food.basis &&
    (food.source !== "recipe" || recent.food.sourceVersion === food.sourceVersion);
  if (!reuse) {
    const { unit, count } = defaultPortion(food);
    return portionItem(food, unit, count);
  }
  // An entry from before units reopens in the unit its label names ("2 medium · 88 g").
  const { unit, count } = portionOf({ ...recent!, food });
  const item = portionItem(food, unit, count, { estimate: recent!.portionLabel.startsWith("≈") });
  // One whose label names none of the food's units keeps its wording, and no unit, so the
  // wording carries forward; "2 serving(s)" is relabeled.
  return recent!.portionUnit || unit !== food.basis || /serving\(s\)/.test(recent!.portionLabel)
    ? item
    : { ...item, portionLabel: recent!.portionLabel, portionUnit: null, portionCount: null };
}
const dayMs = 86_400_000;

/** How well an entry's time fits `at` (minutes): 1 at the same time, 0.1 far away, 0.3 untimed. */
function timeFit(at: number | null, logged: string | null) {
  if (at === null) return 1;
  if (!logged || !validFoodTime(logged)) return 0.3;
  const gap = Math.abs(clockMinutes(logged) - at) / 60;
  const hours = Math.min(gap, 24 - gap);
  return Math.max(0.1, Math.exp(-(hours * hours) / (2 * 1.5 * 1.5)));
}

/**
 * How much each food eaten in the last 180 days belongs in "Log again" at `time`: every entry
 * adds its recency (halving every three weeks) times how near its time of day is. Reads only ids
 * and times, so a long diary stays fast; `lastEntry` is each food's most recent entry id.
 */
export function foodScores(time: string, now = Date.now()) {
  const typed = normalizeFoodTime(time);
  const at = typed ? clockMinutes(typed) : null;
  const today = new Date(`${localDay(new Date(now))}T00:00:00`).getTime();
  const rows = db
    .select({
      id: foodEntries.id,
      food: sql<string | null>`json_extract(${foodEntries.food}, '$.id')`,
      day: foodEntries.day,
      loggedTime: foodEntries.loggedTime,
      createdAt: foodEntries.createdAt,
    })
    .from(foodEntries)
    .where(gte(foodEntries.createdAt, now - 180 * dayMs))
    .orderBy(foodEntries.createdAt, foodEntries.id)
    .all();
  const ages = new Map<string, number>();
  const scores = new Map<string, number>(),
    lastEntry = new Map<string, number>();
  for (const row of rows) {
    // Quick-add estimates are one-offs, not foods to pick again.
    if (!row.food || row.food.startsWith("quick:")) continue;
    // Age counts from the day eaten, so a backfilled or copied day weighs as that day.
    let age = ages.get(row.day);
    if (age === undefined) {
      age = Math.round((today - new Date(`${row.day}T00:00:00`).getTime()) / dayMs);
      ages.set(row.day, age);
    }
    const days = Number.isFinite(age) ? Math.max(0, age) : (now - row.createdAt) / dayMs;
    scores.set(
      row.food,
      (scores.get(row.food) ?? 0) + 0.5 ** (days / 21) * timeFit(at, row.loggedTime)
    );
    lastEntry.set(row.food, row.id);
  }
  return { scores, lastEntry };
}

/**
 * "Log again": the foods eaten most, most recently and nearest this time of day, then saved foods
 * and the person's own foods. Full entries are read only for the top foods and saved foods, so
 * their last portions can be reused; search reads the rest by id when it needs them.
 */
export function loggingChoices(time = currentFoodTime()) {
  const current = new Map([...personalFoods(), ...recipeFoods()].map((food) => [food.id, food]));
  const favorites = favoriteFoods();
  const { scores, lastEntry } = foodScores(time);
  // A deleted recipe can't be logged again.
  for (const id of scores.keys())
    if (id.startsWith("recipe:") && !current.has(id)) scores.delete(id);
  const top = [...scores]
    .sort((a, b) => b[1] - a[1] || lastEntry.get(b[0])! - lastEntry.get(a[0])!)
    .slice(0, 40)
    .map(([id]) => id);
  const read = (ids: number[]) =>
    ids.length ? db.select().from(foodEntries).where(inArray(foodEntries.id, ids)).all() : [];
  const latest = new Map(
    read(
      [...top, ...favorites.map((food) => food.id)].flatMap((id) => lastEntry.get(id) ?? [])
    ).map((entry) => [entry.food.id, entry])
  );
  const choice = (food: Food, entry = latest.get(food.id)): LogChoice => {
    const item = portionFor(food, entry);
    return { key: `food:${food.id}`, title: food.name, detail: item.portionLabel, items: [item] };
  };
  const eaten = top.flatMap((id) => current.get(id) ?? latest.get(id)?.food ?? []);
  const foods = [
    ...new Map(
      [...eaten, ...favorites, ...current.values()].map((food) => [food.id, food])
    ).values(),
  ];
  // Every other food eaten in the window stays findable: its name is read on the first search,
  // and its last entry only when a search matches it.
  const listed = new Set(foods.map((food) => food.id));
  let others: (Named & { entry: number })[] | undefined;
  const recall = (match: (food: Named) => boolean): LogChoice[] => {
    if (!others) {
      const ids = [...scores.keys()].flatMap((id) => (listed.has(id) ? [] : lastEntry.get(id)!));
      others = ids.length
        ? db
            .select({
              entry: foodEntries.id,
              name: sql<string | null>`json_extract(${foodEntries.food}, '$.name')`,
              brand: sql<string | null>`json_extract(${foodEntries.food}, '$.brand')`,
            })
            .from(foodEntries)
            .where(inArray(foodEntries.id, ids))
            .all()
            .map((row) => ({ entry: row.entry, name: row.name ?? "", brand: row.brand ?? "" }))
        : [];
    }
    return read(others.filter(match).map((row) => row.entry)).map((entry) =>
      choice(entry.food, entry)
    );
  };
  /** Choices for catalog results, with the last portion of any food eaten beyond the top ones. */
  const choose = (found: Food[]) => {
    const more = new Map(
      read(
        found.flatMap((food) => (latest.has(food.id) ? [] : (lastEntry.get(food.id) ?? [])))
      ).map((entry) => [entry.food.id, entry])
    );
    return found.map((food) => choice(food, latest.get(food.id) ?? more.get(food.id)));
  };
  // Search ranks the person's foods first, and the ones that score here above the rest.
  const known = new Map<string, number>([...foods.map((food) => [food.id, 0] as const), ...scores]);
  // Saved meals whose foods fit this time come first.
  const fit = (items: MealItem[]) =>
    Math.max(0, ...items.map((item) => scores.get(item.food.id) ?? 0));
  const meals: LogChoice[] = listSavedMeals()
    .map((meal) => ({ meal, score: fit(meal.items) }))
    .sort((a, b) => b.score - a.score)
    .map(({ meal }) => ({
      key: `meal:${meal.id}`,
      title: meal.name,
      detail: `${meal.items.length} foods · saved meal`,
      items: meal.items,
    }));
  return {
    choices: foods.map((food) => choice(food)),
    meals,
    saved: favorites.map((food) => choice(food)),
    latest,
    recall,
    choose,
    known,
    personal: [...current.values()],
  };
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
