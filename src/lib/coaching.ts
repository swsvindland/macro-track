import type { Targets } from "./nutrition";
import { shiftDay } from "./nutrition";

export type Goal = {
  mode: "manual" | "lose" | "maintain" | "gain";
  pace: number;
  startedDay: string;
};
export type Review = {
  method: 1;
  day: string;
  start: string;
  end: string;
  completeDays: number;
  weightDays: number;
  status: "learning" | "holding" | "ready";
  reason: string;
  intake: number | null;
  expenditure: number | null;
  weeklyKg: number | null;
  desiredWeeklyKg: number | null;
  proposed: Targets | null;
};
export function reviewWeek(input: {
  day: string;
  goal: Goal;
  targets: Targets | null;
  days: { day: string; status: string }[];
  entries: { day: string; nutrients: { calories: number } }[];
  weights: { day: string; kg: number }[];
}): Review {
  const { day, goal, targets } = input;
  const start = shiftDay(day, -21),
    end = shiftDay(day, -1);
  const calendar = Array.from({ length: 21 }, (_, i) => shiftDay(start, i));
  const statuses = new Map(input.days.map((row) => [row.day, row.status]));
  const totals = new Map<string, number>();
  for (const entry of input.entries)
    totals.set(entry.day, (totals.get(entry.day) ?? 0) + entry.nutrients.calories);
  const grouped = new Map<string, number[]>();
  for (const weight of input.weights)
    if (calendar.includes(weight.day) && Number.isFinite(weight.kg) && weight.kg > 0) {
      grouped.set(weight.day, [...(grouped.get(weight.day) ?? []), weight.kg]);
    }
  const points = calendar.flatMap((date, x) => {
    const values = grouped.get(date);
    return values ? [{ x, y: values.reduce((a, b) => a + b, 0) / values.length }] : [];
  });
  const result: Review = {
    method: 1,
    day,
    start,
    end,
    completeDays: calendar.filter((date) => statuses.get(date) === "complete" && totals.has(date))
      .length,
    weightDays: points.length,
    status: "learning",
    reason: "",
    intake: null,
    expenditure: null,
    weeklyKg: null,
    desiredWeeklyKg: null,
    proposed: null,
  };
  const hold = (reason: string, status: Review["status"] = "holding") => ({
    ...result,
    status,
    reason,
  });
  if (goal.mode === "manual") return hold("Manual mode keeps your targets under your control.");
  if (!targets) return hold("Set your starting targets first.", "learning");
  if (goal.startedDay > start)
    return hold(
      "Building a 21-day baseline for this goal. Keep logging meals and weight.",
      "learning"
    );
  if (result.completeDays !== 21)
    return hold(
      "Mark all 21 days complete after logging everything. Partial, blank and fasting days pause adjustments; they are never treated as missing calories.",
      "learning"
    );
  if (
    [0, 7, 14].some((offset) => points.filter((p) => p.x >= offset && p.x < offset + 7).length < 3)
  )
    return hold("Add at least three weigh-ins in each of the three weeks.", "learning");
  const meanX = points.reduce((s, p) => s + p.x, 0) / points.length;
  const meanY = points.reduce((s, p) => s + p.y, 0) / points.length;
  const slope =
    points.reduce((s, p) => s + (p.x - meanX) * (p.y - meanY), 0) /
    points.reduce((s, p) => s + (p.x - meanX) ** 2, 0);
  const residual = Math.sqrt(
    points.reduce((s, p) => s + (p.y - (meanY + slope * (p.x - meanX))) ** 2, 0) / points.length
  );
  result.weeklyKg = slope * 7;
  result.intake = calendar.reduce((sum, date) => sum + totals.get(date)!, 0) / 21;
  if (
    Math.abs(slope * 7) > meanY * 0.01 ||
    residual > meanY * 0.01 ||
    points.some((p, i) => i > 0 && Math.abs(p.y - points[i - 1].y) > meanY * 0.02)
  )
    return hold(
      "Weight is changing sharply or fluctuating. Keep your current targets while the trend settles."
    );
  const expenditure = result.intake - slope * 7700;
  result.expenditure = Math.round(expenditure);
  result.desiredWeeklyKg =
    goal.mode === "maintain" ? 0 : ((meanY * goal.pace) / 100) * (goal.mode === "lose" ? -1 : 1);
  const desired = expenditure + (result.desiredWeeklyKg * 7700) / 7;
  if (
    expenditure < 1200 ||
    expenditure > 5000 ||
    desired < 1500 ||
    desired > 5000 ||
    targets.calories < 1500 ||
    targets.calories > 5000
  )
    return hold(
      "This estimate is outside the supported coaching range. Keep or edit your targets manually."
    );
  const cap = Math.min(100, targets.calories * 0.05);
  const calories = Math.round(
    targets.calories + Math.max(-cap, Math.min(cap, desired - targets.calories))
  );
  const macroEnergy = targets.protein * 4 + targets.carbs * 4 + targets.fat * 9;
  if (macroEnergy <= 0) return hold("Set macro targets before accepting an adjustment.");
  const ratio = calories / macroEnergy;
  result.proposed = {
    calories,
    protein: Math.round(targets.protein * ratio),
    carbs: Math.round(targets.carbs * ratio),
    fat: Math.round(targets.fat * ratio),
  };
  return {
    ...result,
    status: "ready",
    reason:
      "Based on 21 complete days and your weight trend. The change is limited to 100 kcal or 5% this week, whichever is smaller. Macros keep your current proportions.",
  };
}
