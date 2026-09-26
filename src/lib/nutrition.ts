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
  /** The unit (a portionUnits key) and count the amount was entered as; unset on older items. */
  portionUnit?: string | null;
  portionCount?: number | null;
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

// --- Amounts in units ---

const glyphs: [number, string][] = [
  [1 / 4, "¼"],
  [1 / 3, "⅓"],
  [1 / 2, "½"],
  [2 / 3, "⅔"],
  [3 / 4, "¾"],
];

/**
 * A typed amount: "2", ".5", "2,5", "1/2", the mixed "1 1/2", "½" and "1½"; NaN otherwise.
 * Weigh-ins keep metrics.parseNumber, which takes plain decimals only.
 */
export function parseAmount(input: string): number {
  const text = input.trim().replace(",", ".").replace(/\s+/g, " ");
  const glyph = /^(\d+)? ?([¼⅓½⅔¾])$/.exec(text);
  if (glyph) return Number(glyph[1] ?? 0) + glyphs.find(([, char]) => char === glyph[2])![0];
  const fraction = /^(?:(\d+) )?(\d+)\/(\d+)$/.exec(text);
  if (fraction)
    return Number(fraction[3]) > 0
      ? Number(fraction[1] ?? 0) + Number(fraction[2]) / Number(fraction[3])
      : NaN;
  return /^(?:\d+\.?\d*|\.\d+)$/.test(text) ? Number(text) : NaN;
}

const weights: Record<string, number> = { g: 1, oz: 28.3495, lb: 453.592, kg: 1000 };
const volumes: Record<string, number> = {
  ml: 1,
  floz: 29.5735,
  cup: 240,
  tbsp: 15,
  tsp: 5,
  l: 1000,
};
const measureNames: [RegExp, string][] = [
  [/^f(?:l(?:uid)?)?\.? ?(?:oz|ounces?)$/, "floz"],
  [/^(?:g|gr|gms?|grams?|grammes?)$/, "g"],
  [/^(?:oz|oza|onz|ounces?)$/, "oz"],
  [/^(?:lbs?|pounds?)$/, "lb"],
  [/^(?:kg|kgs|kilos?|kilograms?)$/, "kg"],
  [/^(?:ml|mls|milliliters?|millilitres?)$/, "ml"],
  [/^(?:l|liters?|litres?)$/, "l"],
  [/^cups?$/, "cup"],
  [/^(?:tbsp|tbs|tbl|tablespoons?)$/, "tbsp"],
  [/^(?:tsp|teaspoons?)$/, "tsp"],
  [/^servings?$/, "serving"],
];
/** The measure a unit name spells: "floz" for "fl. oz.", "cup" for "cups". */
export function measureKey(name: string): string | null {
  const text = name.trim().toLowerCase().replace(/\.$/, "").replace(/\s+/g, " ");
  return measureNames.find(([pattern]) => pattern.test(text))?.[1] ?? null;
}

/**
 * A per-serving food's serving weight (g) and volume (ml), when its label gives them:
 * "1 serving (30 g)", "1 serving (2 tbsp (32g))".
 */
export function servingSize(food: Food) {
  const size: { weight?: number; volume?: number } = {};
  for (const portion of food.portions)
    for (const [, count, name] of portion.label.matchAll(
      /(\d+\s+\d+\/\d+|\d+\/\d+|\d*\.\d+|\d+)\s*(fl(?:uid)?\.?\s*(?:oz|ounces?)\b|[a-z]+)/gi
    )) {
      const unit = measureKey(name) ?? "";
      const kind = weights[unit] ? "weight" : "volume";
      const amount = (parseAmount(count) * (weights[unit] ?? volumes[unit] ?? 0)) / portion.amount;
      if (amount > 0 && Number.isFinite(amount)) size[kind] ??= amount;
    }
  return size;
}

/** Size words describe a portion rather than count it: "2 large", not "2 larges". */
export const sizes = new Set([
  "small",
  "medium",
  "large",
  "regular",
  "extra",
  "jumbo",
  "whole",
  "kid",
]);
const invariant = new Set([...sizes, ..."g oz ml fl floz tbsp tsp kcal lb kg l".split(" ")]);
/** "slice" is "slices" and "cup, chopped" is "cups, chopped"; units and sizes stay as they are. */
export function plural(name: string) {
  const cut = name.search(/\s*[,(]/);
  const head = cut < 0 ? name : name.slice(0, cut);
  const words = head.split(" ");
  const last = words.at(-1) ?? "";
  if (!last || invariant.has(last.toLowerCase()) || /s$/i.test(last)) return name;
  words[words.length - 1] = /[^aeiou]y$/i.test(last)
    ? `${last.slice(0, -1)}ies`
    : /(?:x|ch|sh)$/i.test(last)
      ? `${last}es`
      : `${last}s`;
  return words.join(" ") + (cut < 0 ? "" : name.slice(cut));
}
const singular = (name: string) =>
  /(?:ch|sh|x)es$/i.test(name)
    ? name.slice(0, -2)
    : /[^su]s$/i.test(name)
      ? name.slice(0, -1)
      : name;

/** "3 slices", or "1 serving (1 scoop)" as a catalog portion names it. */
export function countLabel(quantity: number, name: string) {
  const amount = Number(quantity.toFixed(2));
  const unit = name.toLowerCase() || "serving";
  return `${amount} ${amount > 1 ? plural(unit) : unit}`;
}

/** A catalog portion as a count of a named unit: "2 SLICES (57 g)" is 2 of a 28.5 g "slice". */
export function parsePortion(portion: Food["portions"][number]) {
  const match = /^\s*(\d+\s+\d+\/\d+|\d+\/\d+|\d*\.\d+|\d+)\s+(.+)$/.exec(portion.label);
  const count = match ? parseAmount(match[1]) : 1;
  // "1 roll 1 serving" and "1 cup, chopped (1/2\" pieces)" are a "roll" and a "cup".
  let name = (match?.[2] ?? portion.label)
    .split(/[,(]|\s\d/)[0]
    .trim()
    .toLowerCase();
  // Some packaged-food portions are only a weight ("1 151.0g"), which names no unit.
  if (!name || /^\d/.test(name) || !(count > 0) || !(portion.amount > 0)) return null;
  if (count > 1 && !measureKey(name)) name = singular(name);
  return { count, name, perUnit: portion.amount / count };
}

export type PortionUnit = {
  key: string;
  label: string;
  /** How much of the food's basis (g, ml or servings) one unit is. */
  perUnit: number;
  kind: "mass" | "volume" | "count" | "energy";
};
const massUnits = ["g", "oz"];
const volumeUnits = ["ml", "floz", "cup", "tbsp", "tsp"];

/** A portion offered as a measure it names ("2 tbsp" as tbsp) or as its own unit ("slice"). */
function portionKey(food: Food, portion: NonNullable<ReturnType<typeof parsePortion>>, i: number) {
  let measure = measureKey(portion.name);
  // Drinks are counted in fluid ounces.
  if (measure === "oz" && food.basis === "ml") measure = "floz";
  if (measure && (massUnits.includes(measure) || volumeUnits.includes(measure))) return measure;
  if (measure === "serving" && food.basis === "serving" && Math.abs(portion.perUnit - 1) < 1e-6)
    return "serving";
  return `portion:${i}`;
}

/** A portion's words after its count, as its own unit's label: "cup, sliced". */
const fullName = (portion: Food["portions"][number]) =>
  portion.label
    .replace(/^\s*(?:\d+\s+\d+\/\d+|\d+\/\d+|\d*\.\d+|\d+)\s+/, "")
    .trim()
    .toLowerCase()
    .slice(0, 32);

/**
 * The units a food can be logged in, and the unit each of its portions is offered as (null when
 * it isn't). Weights and volumes of the food's own kind are exact; a portion that measures the
 * other kind ("1 cup" of a weighed food) gives the density for all of that kind. Qualified
 * measures ("1 cup, sliced", "1 oz, dry, yields") are their own units instead.
 */
function unitTable(food: Food) {
  const own = new Map<string, number>();
  const natural: (PortionUnit & { index: number; full: boolean })[] = [];
  const placed: (string | null)[] = food.portions.map(() => null);
  const same = (key: string) =>
    food.basis === "g" ? !!weights[key] : food.basis === "ml" && !!volumes[key];
  const near = (a: number, b: number) => Math.abs(a / b - 1) < 0.1;
  food.portions.forEach((portion, i) => {
    const parsed = parsePortion(portion);
    if (!parsed) return;
    const key = portionKey(food, parsed, i);
    const unit = { perUnit: parsed.perUnit, kind: "count" as const, index: i };
    if (key === "serving") placed[i] = key;
    else if (key.startsWith("portion:"))
      natural.push({ ...unit, key, label: parsed.name, full: false });
    // A qualified measure ("1 cup, sliced") is its own unit, named in full.
    else if (portion.label.replace(/\([^)]*\)/g, "").includes(","))
      natural.push({ ...unit, key: `portion:${i}`, label: fullName(portion), full: true });
    // "3 oz" of a weighed food is 3 oz; a portion that disagrees ("4 oz (28 g)") is left out.
    else if (same(key)) {
      if (near(parsed.perUnit, weights[key] ?? volumes[key])) placed[i] = key;
    } else if (!own.has(key)) {
      own.set(key, parsed.perUnit);
      placed[i] = key;
    } else if (near(parsed.perUnit, own.get(key)!)) placed[i] = key;
  });
  const units: PortionUnit[] = [];
  const add = (key: string, perUnit: number, kind: PortionUnit["kind"]) => {
    const value = key === food.basis ? 1 : (own.get(key) ?? perUnit);
    if (value > 0 && Number.isFinite(value))
      units.push({ key, label: key === "floz" ? "fl oz" : key, perUnit: value, kind });
  };
  if (food.basis === "g") {
    for (const key of massUnits) add(key, weights[key], "mass");
    // A cup or tablespoon of the food gives the density that converts every volume.
    const [measure, grams] = [...own].find(([key]) => volumes[key]) ?? [];
    if (measure)
      for (const key of volumeUnits) add(key, (grams! / volumes[measure]) * volumes[key], "volume");
  } else if (food.basis === "ml") {
    for (const key of volumeUnits) add(key, volumes[key], "volume");
    const [measure, ml] = [...own].find(([key]) => weights[key]) ?? [];
    if (measure)
      for (const key of massUnits) add(key, (ml! / weights[measure]) * weights[key], "mass");
  } else {
    const size = servingSize(food);
    if (size.weight) for (const key of massUnits) add(key, weights[key] / size.weight, "mass");
    if (size.volume) for (const key of volumeUnits) add(key, volumes[key] / size.volume, "volume");
    add("serving", 1, "count");
  }
  const offered = new Set(units.map((unit) => unit.key));
  for (const [i, key] of placed.entries()) if (key && !offered.has(key)) placed[i] = null;
  const labels = new Set(units.map((unit) => unit.label));
  for (const { index, full, ...unit } of natural) {
    // Two "slice" portions read as "slice" and "slice (thin)".
    const label = labels.has(unit.label) && !full ? fullName(food.portions[index]) : unit.label;
    if (labels.has(label)) continue;
    labels.add(label);
    units.push({ ...unit, label });
    placed[index] = unit.key;
  }
  if (food.nutrients.calories > 0)
    add("kcal", (food.basis === "serving" ? 1 : 100) / food.nutrients.calories, "energy");
  return { units, placed };
}

/**
 * The units a food can be logged in: weights, volumes where its portions or label make them
 * convertible, its own portions ("slice", "serving", "cup, sliced"), and kcal.
 */
export function portionUnits(food: Food): PortionUnit[] {
  return unitTable(food).units;
}

/** Counted units take fractions ("1½ slices"); weights and energy take plain numbers. */
export const countLike = (unit: Pick<PortionUnit, "key" | "kind">) =>
  unit.kind === "count" || ["cup", "tbsp", "tsp"].includes(unit.key);

export function formatCount(count: number, unit: Pick<PortionUnit, "key" | "kind">) {
  if (!Number.isFinite(count)) return "";
  if (countLike(unit)) {
    const whole = Math.floor(count + 0.005);
    const glyph = glyphs.find(([part]) => Math.abs(count - whole - part) < 0.005)?.[1];
    if (glyph) return `${whole || ""}${glyph}`;
  }
  return String(Number(count.toFixed(2)));
}

/** A count as the amount field shows it: "1½" slices, "120" g. */
export function countText(food: Food, unit: string, count: number) {
  const found = portionUnits(food).find((row) => row.key === unit);
  return found ? formatCount(count, found) : String(count);
}

/**
 * The amount field after a keypad key: a digit, ".", "/" and " " for "1 1/2", or "⌫". A `fresh`
 * (still selected) amount is replaced by a number and cleared by "⌫". Keys that can't lead to an
 * amount are ignored.
 */
export function typeAmount(text: string, key: string, fresh = false) {
  if (key === "⌫") return fresh ? "" : text.slice(0, -1);
  let next = (fresh && /^[\d.]$/.test(key) ? "" : text) + key;
  if (/^0\d/.test(next)) next = next.slice(1);
  return /^(?:\d{0,5}(?:\.\d{0,2})?|\d{1,3}\/\d{0,3}|\d{1,3} (?:\d{1,3}(?:\/\d{0,3})?)?)$/.test(
    next
  )
    ? next
    : text;
}

/** A count rounded for its unit: counts to quarters, grams to whole ones, ounces to tenths. */
export function roundCount(count: number, unit: Pick<PortionUnit, "key" | "kind">) {
  if (countLike(unit)) return Math.max(0.25, Math.round(count * 4) / 4);
  if (unit.key === "oz" || unit.key === "floz") return Math.max(0.1, Math.round(count * 10) / 10);
  return Math.max(1, Math.round(count));
}

/** The same amount of food in another unit, rounded for that unit. */
export function convertCount(units: PortionUnit[], from: string, count: number, to: string) {
  const source = units.find((unit) => unit.key === from);
  const target = units.find((unit) => unit.key === to);
  if (!source || !target || !(count > 0)) return NaN;
  return roundCount((count * source.perUnit) / target.perUnit, target);
}

/** What ± adds: 10 g, ml or kcal, else half a unit. */
export const unitStep = (unit: Pick<PortionUnit, "key" | "kind">) =>
  unit.key === "g" || unit.key === "ml" || unit.kind === "energy" ? 10 : 0.5;

const basisAmount = (amount: number) =>
  String(amount >= 10 ? Math.round(amount) : Number(amount.toFixed(1)));

/** "2 slices · 56 g", "½ serving" or "≈ 300 kcal · 167 g": how an entry's amount reads. */
export function portionLabelFor(
  food: Food,
  unit: string,
  count: number,
  options: { estimate?: boolean } = {}
) {
  const found = portionUnits(food).find((row) => row.key === unit) ?? {
    key: food.basis,
    label: food.basis,
    perUnit: 1,
    kind: food.basis === "serving" ? ("count" as const) : ("mass" as const),
  };
  const amount = count * found.perUnit;
  let label = `${formatCount(count, found)} ${count > 1 ? plural(found.label) : found.label}`;
  if (found.key !== food.basis && !(food.basis === "serving" && found.perUnit === 1))
    label +=
      food.basis === "serving"
        ? ` · ${formatCount(amount, { key: "serving", kind: "count" })} ${amount > 1 ? "servings" : "serving"}`
        : ` · ${basisAmount(amount)} ${food.basis}`;
  return options.estimate ? `≈ ${label}` : label;
}

/** The unit a food's `index`th portion is offered as, when it is offered. */
export function portionUnitKey(food: Food, index: number) {
  return unitTable(food).placed[index] ?? null;
}

/** A food's usual portion: its first listed portion, else 100 g or ml, else one serving. */
export function defaultPortion(food: Food): { unit: string; count: number } {
  const first = food.portions[0];
  const key = first ? portionUnitKey(food, 0) : null;
  // "1 oz (28 g)" is 1 oz, though an ounce is 28.35 g.
  if (key) return { unit: key, count: parsePortion(first)!.count };
  return { unit: food.basis, count: first?.amount ?? (food.basis === "serving" ? 1 : 100) };
}

const leadingCount = /^(?:≈\s*)?((?:\d+ )?\d+\/\d+|\d*[¼⅓½⅔¾]|\d*\.\d+|\d+)\s+(.+?)(?:\s+·\s.*)?$/;

/**
 * The unit and count an item was entered in, or its amount in the food's basis. An item from
 * before units is read from its label ("2 medium · 88 g") when that count still makes its amount.
 */
export function portionOf(
  item: Pick<MealItem, "food" | "amount" | "portionLabel" | "portionUnit" | "portionCount">
) {
  const { portionUnit, portionCount } = item;
  const units = portionUnits(item.food);
  if (portionUnit)
    return portionCount && portionCount > 0 && units.some((unit) => unit.key === portionUnit)
      ? { unit: portionUnit, count: portionCount }
      : { unit: item.food.basis, count: item.amount };
  const match = leadingCount.exec(item.portionLabel.trim());
  const count = match ? parseAmount(match[1]) : NaN;
  const text = match?.[2].toLowerCase() ?? "";
  // "1 cup, sliced" is that unit when the food has it, else a cup; "2 tablespoon" is tbsp.
  const fits = (name: string) => (unit: PortionUnit) =>
    (unit.label === name.slice(0, 32) ||
      plural(unit.label) === name ||
      measureKey(name) === unit.key) &&
    Math.abs(count * unit.perUnit - item.amount) <= item.amount * 0.02;
  const found = units.find(fits(text)) ?? units.find(fits(text.split(/[,(]|\s\d/)[0].trim()));
  return found ? { unit: found.key, count } : { unit: item.food.basis, count: item.amount };
}

/**
 * `count` of a unit of the food as a diary item. An unchanged `previous` item keeps its amount
 * and label, so an estimate stays marked "≈", and an older label without a unit stays so.
 */
export function portionItem(
  food: Food,
  unit: string,
  count: number,
  options: { previous?: MealItem; estimate?: boolean } = {}
): MealItem {
  const found = portionUnits(food).find((row) => row.key === unit);
  if (!found || !Number.isFinite(count) || count <= 0) throw new Error("Enter a valid quantity.");
  const { previous } = options;
  const prior = previous?.food.id === food.id ? portionOf(previous) : null;
  const same = prior?.unit === unit && prior.count === count;
  const amount = same ? previous!.amount : count * found.perUnit;
  const unitless = same && !previous!.portionUnit && unit === food.basis;
  return {
    food,
    amount,
    portionLabel: same ? previous!.portionLabel : portionLabelFor(food, unit, count, options),
    portionUnit: unitless ? null : unit,
    portionCount: unitless ? null : count,
    nutrients: scaleNutrients(food, amount),
  };
}

/** An item times `factor`, as when a saved meal is logged twice; its unit and "≈" carry over. */
export function scaleItem(item: MealItem, factor: number): MealItem {
  if (factor === 1) return item;
  const { unit, count } = portionOf(item);
  return {
    ...item,
    amount: item.amount * factor,
    portionUnit: unit,
    portionCount: count * factor,
    portionLabel: portionLabelFor(item.food, unit, count * factor, {
      estimate: item.portionLabel.startsWith("≈"),
    }),
    nutrients: Object.fromEntries(
      Object.entries(item.nutrients).map(([key, n]) => [key, n === null ? null : n * factor])
    ) as Nutrients,
  };
}
