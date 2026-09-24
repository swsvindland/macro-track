export type Units = "metric" | "imperial" | "stone";
export type Formula = "none" | "male" | "female";
export const sites = [
  "neck",
  "shoulders",
  "chest",
  "waist",
  "abdomen",
  "hips",
  "leftArm",
  "rightArm",
  "leftForearm",
  "rightForearm",
  "leftThigh",
  "rightThigh",
  "leftCalf",
  "rightCalf",
  "leftAnkle",
  "rightAnkle",
] as const;
export const weightUnit = (units: Units) =>
  units === "metric" ? "kg" : units === "stone" ? "st" : "lb";
export const lengthUnit = (units: Units) => (units === "metric" ? "cm" : "in");
export const fromKg = (kg: number, units: Units) =>
  kg / (units === "metric" ? 1 : units === "stone" ? 6.35029318 : 0.45359237);
export const toKg = (value: number, units: Units) =>
  value * (units === "metric" ? 1 : units === "stone" ? 6.35029318 : 0.45359237);
export const fromCm = (cm: number, units: Units) => cm / (units === "metric" ? 1 : 2.54);
export const toCm = (value: number, units: Units) => value * (units === "metric" ? 1 : 2.54);
export function parseNumber(input: string): number {
  const normalized = input.trim().replace(",", ".");
  return /^\d+(\.\d+)?$/.test(normalized) ? Number(normalized) : NaN;
}
export function heightParts(cm: number, digits = 4) {
  const scale = 10 ** digits;
  const total = Math.round(fromCm(cm, "imperial") * scale);
  return { feet: Math.floor(total / (12 * scale)), inches: (total % (12 * scale)) / scale };
}
export function parseHeight(feet: string, inches: string): number {
  const ft = parseNumber(feet);
  const inch = parseNumber(inches.trim() || "0");
  return Number.isInteger(ft) && ft >= 0 && inch >= 0 && inch < 12
    ? toCm(ft * 12 + inch, "imperial")
    : NaN;
}
export function formatHeight(
  cm: number,
  units: Units,
  number: (value: number, digits?: number) => string
): string {
  if (units === "metric") return `${number(cm)} cm`;
  const { feet, inches } = heightParts(cm, 1);
  return `${number(feet, 0)}' ${number(inches, Number.isInteger(inches) ? 0 : 1)}"`;
}
export function localDay(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
export function validDay(day: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const date = new Date(`${day}T12:00:00`);
  return (
    Number.isFinite(date.getTime()) &&
    localDay(date) === day &&
    day <= localDay() &&
    day >= "1900-01-01"
  );
}
export function dayOf(timestamp: string): string {
  return timestamp.length === 10 ? timestamp : localDay(new Date(timestamp));
}
export type TrendPoint = { day: string; raw: number; trend: number };
export function weightTrend(entries: { measuredAt: string; weightKg: number }[]): TrendPoint[] {
  const days = new Map<string, number[]>();
  for (const entry of entries) {
    if (!Number.isFinite(entry.weightKg) || entry.weightKg <= 0) continue;
    const day = dayOf(entry.measuredAt);
    days.set(day, [...(days.get(day) ?? []), entry.weightKg]);
  }
  let previous = 0;
  let previousTime = 0;
  return [...days]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, values], index) => {
      const raw = values.reduce((a, b) => a + b, 0) / values.length;
      const time = Date.parse(`${day}T00:00:00Z`);
      const alpha = 1 - Math.pow(0.5, (time - previousTime) / 86400000 / 7);
      const trend = index === 0 ? raw : previous + alpha * (raw - previous);
      previous = trend;
      previousTime = time;
      return { day, raw, trend };
    });
}
export function bodyFat(
  values: Record<string, number> | undefined,
  height: number | undefined,
  formula: Formula
): number | null {
  if (!values) return null;
  if (values.bodyFat > 0 && values.bodyFat < 75) return values.bodyFat;
  if (!height || !values.neck || formula === "none") return null;
  const circumference =
    formula === "male" ? values.abdomen - values.neck : values.waist + values.hips - values.neck;
  if (!(circumference > 0)) return null;
  const result =
    formula === "male"
      ? 86.01 * Math.log10(circumference / 2.54) - 70.041 * Math.log10(height / 2.54) + 36.76
      : 163.205 * Math.log10(circumference / 2.54) - 97.684 * Math.log10(height / 2.54) - 78.387;
  return result > 0 && result < 75 ? result : null;
}
export function composition(
  weight: number | undefined,
  height: number | undefined,
  fat: number | null
) {
  const bmi = weight && height ? weight / (height / 100) ** 2 : null;
  return { bmi, ffmi: bmi && fat !== null ? bmi * (1 - fat / 100) : null };
}
