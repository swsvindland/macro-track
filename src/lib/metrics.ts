import type { Format, IntlUnit } from "@/vector";
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
/** The Intl unit a weight is shown in; the locale supplies its symbol ("kg", "公斤"). */
export const massUnit = (units: Units): IntlUnit =>
  units === "metric" ? "kilogram" : units === "stone" ? "stone" : "pound";
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
const weightDigits = (units: Units) => (units === "stone" ? 2 : 1);
/** "72.5 kg" at the unit's fixed digits, in the locale's unit order and spacing ("72,5 kg" in fr). */
export function formatWeight(kg: number, units: Units, format: Format, signed = false): string {
  const digits = weightDigits(units),
    value = fromKg(kg, units);
  const { unit, unitFirst, space } = format.unitParts(value, massUnit(units), digits);
  const shown = format.number(value, digits, signed);
  return unitFirst ? `${unit}${space}${shown}` : `${shown}${space}${unit}`;
}
/** "-0.4 kg/wk". A pace that rounds to zero has no sign, so it never reads "-0.0". */
export function formatPace(
  kg: number,
  units: Units,
  format: Format,
  t: (key: "paceWeekly", values: { weight: string }) => string
): string {
  return t("paceWeekly", { weight: formatWeight(kg, units, format, true) });
}
/** "Sep 24", or "Tue, Sep 30" with the weekday; the store's date() always adds the year. */
export function shortDay(day: string, language: string, weekday = false) {
  return new Date(`${day}T12:00:00`).toLocaleDateString(language === "zh" ? "zh-CN" : language, {
    ...(weekday ? { weekday: "short" as const } : {}),
    month: "short",
    day: "numeric",
  });
}
export function localDay(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
/** "Today", "Yesterday", or a short date such as "Fri, Sep 25". */
export function dayLabel(day: string, locale?: string) {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  if (day === localDay()) return "Today";
  if (day === localDay(yesterday)) return "Yesterday";
  return new Date(`${day}T12:00:00`).toLocaleDateString(locale, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
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
/** Daily averages smoothed with a seven-day half-life. Ignored readings are left out. */
export function weightTrend(
  entries: { measuredAt: string; weightKg: number; excluded?: boolean | null }[]
): TrendPoint[] {
  const days = new Map<string, number[]>();
  for (const entry of entries) {
    if (entry.excluded || !Number.isFinite(entry.weightKg) || entry.weightKg <= 0) continue;
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
