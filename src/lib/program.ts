import { shiftDay, type Targets } from "./nutrition";
import { weightTrend, type TrendPoint } from "./metrics";
import type { Goal, Review } from "./coaching";

export type Program = {
  age: number;
  heightCm: number;
  weightKg: number;
  formula: "female" | "male";
  activity: "low" | "light" | "moderate" | "high";
  protein: number;
  diet: "balanced" | "lower-fat" | "lower-carb";
  targetWeightKg: number;
  initialExpenditure: number;
  checkInDay: number;
};
export function validateProgram(p: Program) {
  if (
    !Number.isInteger(p.age) ||
    p.age < 18 ||
    p.age > 100 ||
    !Number.isFinite(p.heightCm) ||
    p.heightCm < 120 ||
    p.heightCm > 230 ||
    !Number.isFinite(p.weightKg) ||
    p.weightKg < 35 ||
    p.weightKg > 350 ||
    !Number.isFinite(p.targetWeightKg) ||
    p.targetWeightKg < 35 ||
    p.targetWeightKg > 350 ||
    !["female", "male"].includes(p.formula) ||
    !["low", "light", "moderate", "high"].includes(p.activity) ||
    !["balanced", "lower-fat", "lower-carb"].includes(p.diet) ||
    ![1.4, 1.6, 2, 2.2].includes(p.protein) ||
    !Number.isFinite(p.initialExpenditure) ||
    p.initialExpenditure < 1200 ||
    p.initialExpenditure > 5000 ||
    !Number.isInteger(p.checkInDay) ||
    p.checkInDay < 0 ||
    p.checkInDay > 6
  )
    throw new Error("Check your age, height, weight and program preferences.");
}
export function initialExpenditure(
  p: Pick<Program, "age" | "heightCm" | "weightKg" | "formula" | "activity">
) {
  const resting =
    10 * p.weightKg + 6.25 * p.heightCm - 5 * p.age + (p.formula === "male" ? 5 : -161);
  return Math.round(resting * { low: 1.2, light: 1.375, moderate: 1.55, high: 1.725 }[p.activity]);
}
export function programMacros(calories: number, weight: number, p: Program): Targets {
  const protein = Math.round(weight * p.protein);
  const remaining = calories - protein * 4;
  const fat = Math.round(
    Math.max(
      weight * 0.6,
      (remaining * { balanced: 0.4, "lower-fat": 0.25, "lower-carb": 0.6 }[p.diet]) / 9
    )
  );
  const carbs = Math.round((calories - protein * 4 - fat * 9) / 4);
  if (calories < 1500 || calories > 5000 || carbs < 0)
    throw new Error(
      "This combination is outside the supported coached range. Choose a slower pace, a lower protein level, or use manual targets."
    );
  return { calories: Math.round(calories), protein, fat, carbs };
}
export function goalRate(goal: Goal, weight: number, target: number) {
  if (goal.mode === "manual") return 0;
  if (goal.mode === "maintain")
    return Math.abs(weight - target) <= 0.7 ? 0 : weight * 0.0015 * (weight > target ? -1 : 1);
  if ((goal.mode === "lose" && weight <= target) || (goal.mode === "gain" && weight >= target))
    return 0;
  return (
    Math.min(Math.abs(weight - target), (weight * goal.pace) / 100) *
    (goal.mode === "lose" ? -1 : 1)
  );
}
export function startingTargets(
  goal: Goal,
  p: Program,
  weight = p.weightKg,
  expenditure = p.initialExpenditure
) {
  validateProgram(p);
  if (
    goalRate(goal, weight, p.targetWeightKg) < 0 &&
    (weight / (p.heightCm / 100) ** 2 < 18.5 || p.targetWeightKg / (p.heightCm / 100) ** 2 < 18.5)
  )
    throw new Error(
      "A cut below the supported weight range needs professional guidance. Use manual targets."
    );
  const rate = goalRate(goal, weight, p.targetWeightKg);
  return programMacros(Math.round(expenditure + (rate * 7700) / 7), weight, p);
}
export type ProgramInput = {
  day: string;
  goal: Goal;
  program: Program;
  targets: Targets;
  days: { day: string; status: string }[];
  entries: { day: string; nutrients: { calories: number } }[];
  weights: { day: string; kg: number; id?: number }[];
  priorExpenditure?: number;
};
export function reviewProgram(input: ProgramInput): Review {
  const { day, goal, program: p, targets } = input;
  const start = shiftDay(day, -21),
    end = shiftDay(day, -1);
  const series = weightTrend(
    input.weights.filter((w) => w.day <= day).map((w) => ({ measuredAt: w.day, weightKg: w.kg }))
  );
  const latest = series.at(-1);
  const weight = latest?.trend ?? p.weightKg;
  const statuses = new Map(input.days.map((row) => [row.day, row.status]));
  const totals = new Map<string, number>();
  input.entries.forEach((row) =>
    totals.set(row.day, (totals.get(row.day) ?? 0) + row.nutrients.calories)
  );
  const result: Review = {
    method: 2,
    day,
    start,
    end,
    completeDays: 0,
    weightDays: series.filter((row) => row.day >= start && row.day <= end).length,
    status: "learning",
    reason: "",
    intake: null,
    expenditure: input.priorExpenditure ?? p.initialExpenditure,
    weeklyKg: null,
    desiredWeeklyKg: goalRate(goal, weight, p.targetWeightKg),
    proposed: null,
    trendWeightKg: weight,
    targetWeightKg: p.targetWeightKg,
    observedDays: 0,
  };
  const hold = (reason: string, status: Review["status"] = "learning") => ({
    ...result,
    status,
    reason,
  });
  const calendar = Array.from({ length: 21 }, (_, i) => shiftDay(start, i));
  const known = (date: string) =>
    (statuses.get(date) === "complete" && totals.has(date)) ||
    (statuses.get(date) === "fasting" && !totals.has(date));
  result.completeDays = calendar.filter(known).length;
  if (goal.mode === "manual") return hold("Manual targets stay under your control.", "holding");
  // Interpolate only between observed trend points at most seven days apart.
  const at = (date: string) => {
    const after = series.findIndex((row) => row.day >= date);
    if (after < 0) return null;
    if (series[after].day === date) return series[after].trend;
    if (after === 0) return null;
    const a = series[after - 1],
      b = series[after];
    const span = (Date.parse(b.day) - Date.parse(a.day)) / 86400000;
    return span > 7
      ? null
      : a.trend +
          ((b.trend - a.trend) * ((Date.parse(date) - Date.parse(a.day)) / 86400000)) / span;
  };
  // Use complete contiguous intervals, never project known-day intake across an unknown day.
  let used = 0,
    calories = 0,
    deltaKg = 0;
  let run: string[] = [];
  const consume = () => {
    if (run.length >= 7) {
      const first = at(shiftDay(run[0], -1)),
        last = at(run.at(-1)!);
      if (first !== null && last !== null) {
        used += run.length;
        deltaKg += last - first;
        calories += run.reduce((sum, date) => sum + (totals.get(date) ?? 0), 0);
      }
    }
    run = [];
  };
  for (const date of calendar) {
    if (known(date) && at(date) !== null && at(shiftDay(date, -1)) !== null) run.push(date);
    else consume();
  }
  consume();
  result.observedDays = used;
  if (!latest || latest.day < shiftDay(end, -3))
    return hold("Add a recent weigh-in so the plan can use your current trend.");
  if (used < 12 || result.weightDays < 6)
    return hold(
      "Learning from your logs. Aim for 12 covered days in blocks of at least 7 and six weigh-in days within the last three weeks. Gaps pause learning without resetting it."
    );
  result.intake = calories / used;
  result.weeklyKg = (deltaKg / used) * 7;
  const raw = result.intake - (deltaKg / used) * 7700;
  const recent = series.filter((row) => row.day >= start);
  const apart = (a: TrendPoint, b: TrendPoint) => Math.abs(a.raw - b.raw) > weight * 0.03;
  const jumped = recent.some((row, i) => i > 0 && apart(recent[i - 1], row));
  if (jumped) {
    // A day far from the days on both sides of it is likely a misread that can be deleted.
    // A lasting step has no such day, so it only holds the review.
    const raws = recent.map((row) => row.raw).sort((a, b) => a - b);
    const median = (raws[(raws.length - 1) >> 1] + raws[raws.length >> 1]) / 2;
    const off = (kg: number) => Math.abs(kg - median);
    const suspect = series
      .filter(
        (row, i) =>
          row.day >= start &&
          [series[i - 1], series[i + 1]].every((near) => !near || apart(near, row))
      )
      .sort((a, b) => off(b.raw) - off(a.raw))[0];
    const reading =
      suspect &&
      input.weights
        .filter((w) => w.day === suspect.day && Number.isFinite(w.kg) && w.kg > 0)
        .reduce((worst, w) => (off(w.kg) > off(worst.kg) ? w : worst));
    if (reading)
      return {
        ...hold(
          "One weigh-in is far from the ones around it. Delete it if it was a misread; otherwise keep the current plan while the trend settles.",
          "holding"
        ),
        outlier: { day: reading.day, kg: reading.kg, id: reading.id },
      };
  }
  if (jumped || Math.abs(result.weeklyKg) > weight * 0.01)
    return hold(
      "Your weight is changing sharply. Keep the current plan while the trend settles.",
      "holding"
    );
  if (!Number.isFinite(raw) || raw < 1200 || raw > 5000)
    return hold(
      "This expenditure estimate is outside the supported range. Keep your targets and review your logs.",
      "holding"
    );
  // Damp new evidence toward the last reviewed estimate, independently of adherence.
  result.expenditure = Math.round(
    result.expenditure! + 0.35 * Math.max(-500, Math.min(500, raw - result.expenditure!))
  );
  try {
    const desired = startingTargets(goal, p, weight, result.expenditure);
    const cap = Math.min(150, targets.calories * 0.075);
    const calories = Math.round(
      targets.calories + Math.max(-cap, Math.min(cap, desired.calories - targets.calories))
    );
    result.proposed = programMacros(calories, weight, p);
  } catch (e) {
    return hold(e instanceof Error ? e.message : "Review your program settings.", "holding");
  }
  const reached = goal.mode !== "maintain" && result.desiredWeeklyKg === 0;
  return {
    ...result,
    status: "ready",
    reason: reached
      ? "Your trend has reached the goal. This review moves your target toward maintenance; switch to Maintain to hold this weight."
      : "Your plan is recalculated from logged intake, normalized weight and your goal. Protein follows body weight; carbs and fat follow your preferences. You do not need to hit the old targets perfectly.",
  };
}
