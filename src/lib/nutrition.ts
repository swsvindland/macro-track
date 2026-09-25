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
  source: "usda" | "off" | "custom";
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

export function normalizeBarcode(input: string): string | null {
  const code = input.trim();
  if (!/^(?:\d{8}|\d{12}|\d{13}|\d{14})$/.test(code)) return null;
  const total = [...code.slice(0, -1)]
    .reverse()
    .reduce((sum, digit, i) => sum + Number(digit) * (i % 2 ? 1 : 3), 0);
  return (10 - (total % 10)) % 10 === Number(code.at(-1)) ? code.padStart(14, "0") : null;
}

export function searchExpression(input: string): string {
  return (
    input
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .match(/[\p{L}\p{N}]+/gu) ?? []
  )
    .slice(0, 8)
    .map((token) => `"${token}"*`)
    .join(" AND ");
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

export function shiftDay(day: string, offset: number): string {
  const date = new Date(`${day}T12:00:00`);
  date.setDate(date.getDate() + offset);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
