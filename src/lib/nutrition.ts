export type Nutrients = {
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  fiber: number | null;
  sodium: number | null;
};
export type Food = {
  id: string;
  name: string;
  brand: string;
  barcode: string | null;
  basis: "g" | "ml" | "serving";
  nutrients: Nutrients;
  portions: { label: string; amount: number }[];
  source: "usda" | "off" | "custom" | "recipe";
  sourceVersion: string;
};
export type MealItem = {
  food: Food;
  amount: number;
  portionLabel: string;
  nutrients: Nutrients;
};
export const meals = ["Breakfast", "Lunch", "Dinner", "Snacks"] as const;
export type Meal = (typeof meals)[number];
export const dayStates = ["in-progress", "complete", "partial", "fasting"] as const;
export type DayState = (typeof dayStates)[number];
export type Targets = Pick<Nutrients, "calories" | "protein" | "carbs" | "fat">;

function checkDigitValid(code: string) {
  const total = [...code.slice(0, -1)]
    .reverse()
    .reduce((sum, digit, i) => sum + Number(digit) * (i % 2 ? 1 : 3), 0);
  return (10 - (total % 10)) % 10 === Number(code.at(-1));
}
/** The 12-digit UPC-A form of an 8-digit UPC-E code (number system, 6 digits, check digit). */
function expandUpcE(code: string) {
  const [system, a, b, c, d, e, last, check] = code;
  const body =
    last <= "2"
      ? `${a}${b}${last}0000${c}${d}${e}`
      : last === "3"
        ? `${a}${b}${c}00000${d}${e}`
        : last === "4"
          ? `${a}${b}${c}${d}00000${e}`
          : `${a}${b}${c}${d}${e}0000${last}`;
  return `${system}${body}${check}`;
}
/**
 * The 14-digit keys a barcode may be stored under, most likely first. An 8-digit code is EAN-8
 * or UPC-E (cans, gum), whose check digit is its UPC-A form's. Catalogs keep EAN-8 codes as
 * printed, so the UPC-A form comes first only when the camera read a UPC-E symbol.
 */
export function barcodeCandidates(input: string, symbology?: string): string[] {
  const code = input.trim();
  if (!/^(?:\d{8}|\d{12}|\d{13}|\d{14})$/.test(code)) return [];
  const keys = checkDigitValid(code) ? [code] : [];
  if (code.length === 8 && code[0] <= "1" && symbology !== "ean8") {
    const upcA = expandUpcE(code);
    if (checkDigitValid(upcA)) {
      if (symbology === "upc_e") keys.unshift(upcA);
      else keys.push(upcA);
    }
  }
  return keys.map((key) => key.padStart(14, "0"));
}
export function normalizeBarcode(input: string): string | null {
  return barcodeCandidates(input)[0] ?? null;
}

export function scaleNutrients(food: Food, amount: number): Nutrients {
  if (!Number.isFinite(amount) || amount <= 0 || amount > 100000)
    throw new Error("Enter a valid quantity.");
  const factor = amount / (food.basis === "serving" ? 1 : 100);
  return Object.fromEntries(
    Object.entries(food.nutrients).map(([key, value]) => [
      key,
      value === null ? null : value * factor,
    ])
  ) as Nutrients;
}

export function totalNutrients(items: Nutrients[]): Nutrients {
  const total: Nutrients = { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, sodium: 0 };
  for (const item of items) {
    for (const key of Object.keys(total) as (keyof Nutrients)[]) {
      if (key === "fiber" || key === "sodium")
        total[key] = total[key] === null || item[key] === null ? null : total[key]! + item[key]!;
      else total[key] += item[key];
    }
  }
  return total;
}

export function validateFood(food: Food): void {
  if (!food.name.trim() || (food.source === "custom" && food.name.length > 200))
    throw new Error("Enter a food name up to 200 characters.");
  if (!["g", "ml", "serving"].includes(food.basis))
    throw new Error("Choose a valid serving basis.");
  for (const key of ["calories", "protein", "carbs", "fat"] as const) {
    const value = food.nutrients[key];
    if (!Number.isFinite(value) || value < 0 || value > 10000)
      throw new Error("Enter valid, non-negative nutrition values.");
  }
  for (const key of ["fiber", "sodium"] as const) {
    const value = food.nutrients[key];
    if (value !== null && (!Number.isFinite(value) || value < 0 || value > 100000))
      throw new Error("Enter valid nutrient values.");
  }
  if (food.barcode && !normalizeBarcode(food.barcode)) throw new Error("Check the barcode digits.");
}

export type CustomFoodInput = {
  name: string;
  brand: string;
  barcode: string | null;
  basis: Food["basis"];
  /** Per 100 g or ml, or per serving. */
  nutrients: Nutrients;
  /** For per-serving values: the household measure and, when known, its weight or volume. */
  serving?: { label: string; amount: number | null; unit: "g" | "ml" };
};

/**
 * A food entered from a label. Per-serving values with a known serving weight are stored per
 * 100 g or ml with the serving as a portion, so the food can be logged by serving or by weight.
 */
export function customFood(
  input: CustomFoodInput,
  id = `custom:${Date.now()}:${Math.random().toString(36).slice(2)}`
): Food {
  const measure = input.serving?.label.trim().slice(0, 40) ?? "";
  const servingName = measure ? `1 serving (${measure})` : "1 serving";
  const weight = input.serving?.amount;
  const byWeight = input.basis === "serving" && weight != null;
  if (byWeight && (!Number.isFinite(weight) || weight <= 0 || weight > 5000))
    throw new Error("Enter a serving weight above 0 and no greater than 5,000.");
  const food: Food = {
    id,
    name: input.name.trim(),
    brand: input.brand.trim(),
    barcode: input.barcode,
    basis: byWeight ? input.serving!.unit : input.basis,
    nutrients: byWeight
      ? (Object.fromEntries(
          Object.entries(input.nutrients).map(([key, value]) => [
            key,
            value === null ? null : (value * 100) / weight!,
          ])
        ) as Nutrients)
      : input.nutrients,
    portions: byWeight
      ? [{ label: servingName, amount: weight! }]
      : input.basis === "serving" && measure
        ? [{ label: servingName, amount: 1 }]
        : [],
    source: "custom",
    sourceVersion: "1",
  };
  validateFood(food);
  return food;
}

export function shiftDay(day: string, offset: number): string {
  const date = new Date(`${day}T12:00:00`);
  date.setDate(date.getDate() + offset);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export type RecipeIngredient = { food: Food; amount: number };
export type Recipe = {
  id: string;
  name: string;
  servings: number;
  yieldGrams?: number | null;
  ingredients: RecipeIngredient[];
  revision: number;
};

export function recipeFood(recipe: Recipe): Food {
  if (!recipe.name.trim() || recipe.name.trim().length > 80)
    throw new Error("Give your recipe a name up to 80 characters.");
  if (!Number.isFinite(recipe.servings) || recipe.servings <= 0 || recipe.servings > 1000)
    throw new Error("Enter a batch yield above 0 and no greater than 1,000 servings.");
  if (!recipe.ingredients.length || recipe.ingredients.length > 100)
    throw new Error("Add between 1 and 100 ingredients.");
  if (
    recipe.yieldGrams != null &&
    (!Number.isFinite(recipe.yieldGrams) || recipe.yieldGrams <= 0 || recipe.yieldGrams > 100000)
  )
    throw new Error("Enter a cooked batch weight above 0 and no greater than 100,000 g.");
  const divisor = recipe.yieldGrams ? recipe.yieldGrams / 100 : recipe.servings;
  const totals = totalNutrients(
    recipe.ingredients.map(({ food, amount }) => {
      validateFood(food);
      return scaleNutrients(food, amount);
    })
  );
  const food: Food = {
    id: `recipe:${recipe.id}`,
    name: recipe.name.trim(),
    brand: "",
    barcode: null,
    basis: recipe.yieldGrams ? "g" : "serving",
    source: "recipe",
    sourceVersion: String(recipe.revision),
    nutrients: Object.fromEntries(
      Object.entries(totals).map(([key, value]) => [key, value === null ? null : value / divisor])
    ) as Nutrients,
    portions: [
      { label: "1 serving", amount: recipe.yieldGrams ? recipe.yieldGrams / recipe.servings : 1 },
    ],
  };
  validateFood(food);
  return food;
}

export type DayProjection =
  | { status: "no-target"; eaten: number }
  | { status: "over"; eaten: number; target: number; over: number }
  | { status: "under"; eaten: number; target: number; left: number }
  | {
      status: "on-pace" | "heading-over";
      eaten: number;
      target: number;
      left: number;
      projected: number;
    };

/** Rounds an estimate to the nearest 50 kcal so it reads as an estimate. */
export const roughly = (value: number) => Math.max(50, Math.round(value / 50) * 50);

/**
 * Where today is heading. Food already eaten counts once; food planned for later
 * today replaces the usual rest of the day rather than adding to it. A projection
 * needs targets, at least one entry and a typical rest-of-day from history.
 */
export function projectDay(input: {
  entries: { loggedTime: string | null; calories: number }[];
  target: number | null;
  typical: number | null;
  now: string;
}): DayProjection {
  const eaten = input.entries.reduce((sum, row) => sum + row.calories, 0);
  const target = input.target;
  if (target === null) return { status: "no-target", eaten };
  if (eaten > target) return { status: "over", eaten, target, over: eaten - target };
  const left = target - eaten;
  if (input.typical === null || !input.entries.length)
    return { status: "under", eaten, target, left };
  let soFar = 0,
    planned = 0;
  for (const row of input.entries)
    if (row.loggedTime && row.loggedTime > input.now) planned += row.calories;
    else soFar += row.calories;
  const projected = soFar + Math.max(planned, input.typical);
  return {
    status: projected - target > Math.max(100, target * 0.05) ? "heading-over" : "on-pace",
    eaten,
    target,
    left,
    projected,
  };
}
