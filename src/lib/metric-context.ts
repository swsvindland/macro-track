import type { Formula } from "./metrics";

export type DashboardMetric = "bmi" | "bodyFat" | "ffmi" | "shoulderWaistRatio";
export type MetricTone = "neutral" | "info" | "success" | "warning" | "danger";

export function shoulderWaistRatio(values: Record<string, number> | undefined): number | null {
  const waist = values?.waist;
  const shoulders = values?.shoulders;
  return waist &&
    shoulders &&
    Number.isFinite(waist) &&
    Number.isFinite(shoulders) &&
    waist > 0 &&
    shoulders > 0
    ? shoulders / waist
    : null;
}

// Adult screening references, not diagnoses. Body-fat bands follow ACE categories;
// FFMI bands are simplified app comparisons, not clinical cutoffs from Schutz et al.
// Citations and interpretation limits are available in health-sources.
// The selected Navy formula supplies the reference sex; "none" must not imply male.
export function metricContext(
  metric: DashboardMetric,
  value: number | null,
  formula: Formula
): {
  label: string;
  tone: MetricTone;
  help: string;
  range?: [number, number];
} {
  const help = `${metric}Context`;
  if (value === null || !Number.isFinite(value))
    return { label: "metricMissing", tone: "neutral", help };
  if (metric === "shoulderWaistRatio")
    return {
      label:
        Math.round(value * 100) < 162
          ? "ratioBelowGoal"
          : Math.round(value * 100) > 162
            ? "ratioAboveGoal"
            : "ratioAtGoal",
      tone:
        Math.round(value * 100) < 162
          ? "warning"
          : Math.round(value * 100) > 162
            ? "info"
            : "success",
      help,
    };
  if (metric === "bmi")
    return {
      label:
        value < 18.5
          ? "bmiLow"
          : value < 25
            ? "bmiHealthy"
            : value < 30
              ? "bmiElevated"
              : "bmiHigh",
      tone: value < 18.5 ? "warning" : value < 25 ? "success" : value < 30 ? "warning" : "danger",
      help,
      range: [18.5, 24.9],
    };
  if (formula === "none") return { label: "metricChooseReference", tone: "neutral", help };
  if (metric === "bodyFat") {
    const [low, lean, high] = formula === "male" ? [6, 14, 25] : [14, 21, 32];
    return {
      label:
        value < low ? "fatLow" : value < lean ? "fatLean" : value < high ? "fatTypical" : "fatHigh",
      tone: value < low ? "warning" : value < lean ? "info" : value < high ? "success" : "warning",
      help,
      range: [lean, high - 1],
    };
  }
  const range: [number, number] = formula === "male" ? [17, 20] : [14, 17];
  return {
    label: value < range[0] ? "ffmiLow" : value <= range[1] ? "ffmiTypical" : "ffmiHigh",
    tone: value < range[0] ? "warning" : value <= range[1] ? "success" : "info",
    help,
    range,
  };
}
