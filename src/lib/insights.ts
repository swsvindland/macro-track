import { and, asc, desc, gte, isNotNull, lte, sql } from "drizzle-orm";
import { checkIns, coachingGoals, db, diaryDays, foodEntries, nutritionTargets } from "@/db";
import { currentGoal, nextCheckInDay } from "./coaching-store";
import { weightTrend, type TrendPoint } from "./metrics";
import { shiftDay, shiftedTargets, type DayState, type Targets } from "./nutrition";
import { dailyTrend, goalRate, observeRuns } from "./program";

const DAY = 86400000;
/** Food totals and the logging status of one day. */
export type DayIntake = Targets & { entries: number; status: DayState | null };
type Weights = { measuredAt: string; weightKg: number; excluded?: boolean | null }[];

const total = (key: keyof Targets) =>
  sql<number>`total(json_extract(${foodEntries.nutrients}, ${sql.raw(`'$.${key}'`)}))`;
/** Every day from `from` to `to` with food or a status, in one grouped read of each table. */
export function dailyIntake(from: string, to: string) {
  const days = new Map<string, DayIntake>();
  const rows = db
    .select({
      day: foodEntries.day,
      calories: total("calories"),
      protein: total("protein"),
      carbs: total("carbs"),
      fat: total("fat"),
      entries: sql<number>`count(*)`,
    })
    .from(foodEntries)
    .where(and(gte(foodEntries.day, from), lte(foodEntries.day, to)))
    .groupBy(foodEntries.day)
    .all();
  for (const { day, ...row } of rows) days.set(day, { ...row, status: null });
  for (const { day, status } of db
    .select()
    .from(diaryDays)
    .where(and(gte(diaryDays.day, from), lte(diaryDays.day, to)))
    .all()) {
    const known = days.get(day);
    if (known) known.status = status;
    else days.set(day, { calories: 0, protein: 0, carbs: 0, fat: 0, entries: 0, status });
  }
  return days;
}
/** Dated targets read once, then looked up for any day, shifted as `targetsForDay` shifts them. */
export function targetTimeline() {
  const rows = db.select().from(nutritionTargets).orderBy(asc(nutritionTargets.effectiveDay)).all();
  const goals = db
    .select({ startedDay: coachingGoals.startedDay, program: coachingGoals.program })
    .from(coachingGoals)
    .orderBy(desc(coachingGoals.id))
    .all();
  return (day: string) => {
    let targets: Targets | null = null;
    for (const row of rows) {
      if (row.effectiveDay > day) break;
      targets = row.targets;
    }
    const shift = goals.find((goal) => goal.startedDay <= day)?.program?.shift;
    return targets && shiftedTargets(targets, shift, day);
  };
}
/** A day coaching can learn from: complete with food, or an explicit fast. */
const known = (day?: DayIntake) =>
  !!day &&
  ((day.status === "complete" && day.entries > 0) ||
    (day.status === "fasting" && day.entries === 0));

export type ExpenditurePoint = {
  day: string;
  kcal: number;
  low: number;
  high: number;
  /** No new evidence that day: the last estimate, or a program's starting estimate, carries on. */
  holding: boolean;
};
const WINDOW = 21;
// How much of a day's scale noise survives the trend's seven-day half-life.
const trendNoise = Math.sqrt((1 - 0.5 ** (1 / 7)) / (1 + 0.5 ** (1 / 7)));
const smoothing = 1 - 0.5 ** (1 / 4);
/**
 * A daily expenditure estimate from `from` to `to`. Each day applies method 2's relationship
 * (intake − trend change × 7,700 kcal/kg) to the usable days among the 21 ending that day, and the
 * result is smoothed with a four-day half-life, each step capped at 500 kcal. Days without 12
 * usable days and six weigh-ins hold the last estimate; before any evidence, a program's starting
 * estimate holds. The range narrows with more usable days and steadier weigh-ins. Coaching's own
 * check-ins are unaffected.
 */
export function estimateExpenditure(input: {
  from: string;
  to: string;
  intake: Map<string, DayIntake>;
  trend: TrendPoint[];
  /** Programs' starting estimates from the day each took effect, oldest first. */
  provisional?: { day: string; kcal: number }[];
}): ExpenditurePoint[] {
  const start = Date.parse(input.from) - WINDOW * DAY,
    length = (Date.parse(input.to) - start) / DAY + 1;
  if (!(length > WINDOW)) return [];
  const trend = dailyTrend(input.trend, new Date(start).toISOString().slice(0, 10), length);
  const noise = new Map(input.trend.map((point) => [point.day, (point.raw - point.trend) ** 2]));
  // Running totals of weigh-in days and their squared noise make each window's sums O(1).
  const weighIns = [0],
    squares = [0];
  const days = Array.from({ length }, (_, i) => {
    const day = new Date(start + i * DAY).toISOString().slice(0, 10),
      row = input.intake.get(day),
      square = noise.get(day);
    weighIns.push(weighIns[i] + (square === undefined ? 0 : 1));
    squares.push(squares[i] + (square ?? 0));
    return { day, known: known(row), calories: row?.calories ?? 0, trend: trend[i] };
  });
  const provisional = input.provisional ?? [];
  const points: ExpenditurePoint[] = [];
  let kcal: number | null = null,
    spread = 0,
    learned = false,
    seed: number | null = null,
    next = 0;
  for (let i = WINDOW; i < length; i++) {
    const { day } = days[i];
    while (next < provisional.length && provisional[next].day <= day)
      seed = provisional[next++].kcal;
    const first = i - WINDOW + 1;
    const { used, calories, deltaKg } = observeRuns(
      days.slice(first, i + 1),
      days[i - WINDOW].trend
    );
    const weighed = weighIns[i + 1] - weighIns[first];
    const raw = used >= 12 && weighed >= 6 ? (calories - deltaKg * 7700) / used : NaN;
    if (raw >= 1200 && raw <= 5000) {
      const kg = Math.sqrt(Math.max(0, squares[i + 1] - squares[first]) / weighed) * trendNoise;
      const width = Math.min(
        400,
        Math.max(50, (7700 * Math.SQRT2 * kg) / used + 200 * (1 - used / WINDOW))
      );
      kcal = kcal === null ? raw : kcal + smoothing * Math.max(-500, Math.min(500, raw - kcal));
      spread = learned ? spread + smoothing * (width - spread) : width;
      learned = true;
    } else if (!learned) {
      if (seed === null) continue;
      kcal = seed;
      spread = 300;
    } else spread = Math.min(400, spread + 10);
    points.push({
      day,
      kcal: Math.round(kcal!),
      low: Math.round(kcal! - spread),
      high: Math.round(kcal! + spread),
      holding: !(raw >= 1200 && raw <= 5000),
    });
  }
  return points;
}
/** Each program's starting estimate from the day it took effect. */
function provisionalEstimates() {
  return db
    .select({ day: coachingGoals.startedDay, program: coachingGoals.program })
    .from(coachingGoals)
    .where(isNotNull(coachingGoals.program))
    .orderBy(asc(coachingGoals.id))
    .all()
    .map((row) => ({ day: row.day, kcal: row.program!.initialExpenditure }));
}
/** Estimates saved by method 2 check-ins, oldest first. */
export function checkInEstimates() {
  return db
    .select({ day: checkIns.day, review: checkIns.review })
    .from(checkIns)
    .orderBy(asc(checkIns.day))
    .all()
    .flatMap(({ day, review }) =>
      review.method === 2 && review.expenditure !== null ? [{ day, kcal: review.expenditure }] : []
    );
}
function expenditureFrom(
  intake: Map<string, DayIntake>,
  trend: TrendPoint[],
  from: string,
  to: string
) {
  const provisional = provisionalEstimates();
  let first = provisional[0]?.day ?? to;
  for (const day of intake.keys()) if (day < first) first = day;
  // The estimate always starts from the first logged day, so every range shows the same values.
  return estimateExpenditure({ from: first, to, intake, trend, provisional }).filter(
    (point) => point.day >= from
  );
}
/** The daily expenditure estimate from `from` to `to`, with no limit on history. */
export function expenditureSeries(from: string, to: string, weights: Weights) {
  return expenditureFrom(dailyIntake("", to), weightTrend(weights), from, to);
}

/** The first day of the week holding `day`; `firstWeekday` is 0 for Sunday, 1 for Monday. */
export function weekStart(day: string, firstWeekday = 1) {
  const weekday = new Date(`${day}T12:00:00`).getDay();
  return shiftDay(day, -((weekday - firstWeekday + 7) % 7));
}
export type WeekDay = {
  day: string;
  eaten: Targets;
  target: Targets | null;
  /** Complete with food, or fasted: counted against the budget. */
  logged: boolean;
  /** Marked partial: left out of the budget, like an unanswered earlier day. */
  partial: boolean;
};
export function weekDays(
  start: string,
  intake: Map<string, DayIntake>,
  targetOn: (day: string) => Targets | null
): WeekDay[] {
  return Array.from({ length: 7 }, (_, i) => {
    const day = shiftDay(start, i),
      row = intake.get(day);
    return {
      day,
      eaten: {
        calories: row?.calories ?? 0,
        protein: row?.protein ?? 0,
        carbs: row?.carbs ?? 0,
        fat: row?.fat ?? 0,
      },
      target: targetOn(day),
      logged: known(row),
      partial: row?.status === "partial",
    };
  });
}
// A day's share stays this close to its target, and at 1,500 kcal or more unless the target is lower.
const MARGIN = 500;
/**
 * The week against its budget. Days count once complete or fasted, today included; unanswered and
 * partial days are left out of both sides, never treated as zero. What is left is shared by today,
 * while it is open, and the days after it. Food eaten today counts in full once it passes that
 * share, and the days after today split the rest.
 */
export function weekBudget(days: WeekDay[], today: string) {
  const counted = days.filter((day) => day.day <= today && day.logged && day.target),
    now = days.find((day) => day.day === today && !day.logged && !day.partial && day.target),
    after = days.filter((day) => day.day > today && day.target);
  const sum = (list: WeekDay[], pick: (day: WeekDay) => number) =>
    list.reduce((total, day) => total + pick(day), 0);
  const eaten = sum(counted, (day) => day.eaten.calories),
    budget = sum(counted, (day) => day.target!.calories);
  const adherence = (key: "protein" | "carbs" | "fat") => {
    const target = sum(counted, (day) => day.target![key]);
    return target > 0 ? sum(counted, (day) => day.eaten[key]) / target : null;
  };
  const open = now ? [now, ...after] : after,
    left = budget - eaten + sum(open, (day) => day.target!.calories);
  const spent = !!now && now.eaten.calories > left / open.length,
    rest = spent ? after : open;
  const perDay = rest.length ? (left - (spent ? now!.eaten.calories : 0)) / rest.length : null,
    target = sum(rest, (day) => day.target!.calories) / rest.length;
  const evidence = counted.length > 0 || spent;
  return {
    days: counted.length,
    average: counted.length ? eaten / counted.length : null,
    averageTarget: counted.length ? budget / counted.length : null,
    /**
     * Calories a day for the rest of the week that land it on budget; null when nothing is known
     * yet, no days are left, or it would stray more than 500 kcal from the targets.
     */
    restPerDay:
      evidence &&
      perDay !== null &&
      perDay >= Math.max(target - MARGIN, Math.min(1500, target)) &&
      perDay <= target + MARGIN
        ? perDay
        : null,
    /** Calories over (positive) or under budget so far; today counts what passes its target. */
    balance: evidence
      ? eaten - budget + (now ? Math.max(0, now.eaten.calories - now.target!.calories) : 0)
      : null,
    adherence: { protein: adherence("protein"), carbs: adherence("carbs"), fat: adherence("fat") },
  };
}
export type WeekBudget = ReturnType<typeof weekBudget>;

export type GoalProjection = {
  mode: "lose" | "maintain" | "gain";
  targetKg: number;
  /** The latest trend weight; null before the first weigh-in. */
  weightKg: number | null;
  /** At the goal, or inside maintenance's band. */
  reached: boolean;
  /** When the trend reaches the goal at the program's pace. */
  eta: string | null;
};
/** The trend's change over about three weeks, in kg a week; null without weigh-ins to span it. */
export function trendPace(trend: TrendPoint[]) {
  const latest = trend.at(-1);
  if (!latest) return null;
  const around = Date.parse(shiftDay(latest.day, -21)),
    gap = (point: TrendPoint) => Math.abs(Date.parse(point.day) - around);
  const anchor = trend
    .filter(
      (point) => point.day >= shiftDay(latest.day, -28) && point.day <= shiftDay(latest.day, -7)
    )
    .reduce<TrendPoint | null>(
      (best, point) => (!best || gap(point) < gap(best) ? point : best),
      null
    );
  return anchor
    ? ((latest.trend - anchor.trend) / ((Date.parse(latest.day) - Date.parse(anchor.day)) / DAY)) *
        7
    : null;
}
type GoalRow = ReturnType<typeof currentGoal>;
/** Where the normalized trend stands against a program's goal, and when it gets there. */
export function goalProjection(
  trend: TrendPoint[],
  goal: GoalRow,
  today: string
): GoalProjection | null {
  if (!goal?.program || goal.mode === "manual") return null;
  const target = goal.program.targetWeightKg,
    weight = trend.at(-1)?.trend ?? null;
  const projection = { mode: goal.mode, targetKg: target, weightKg: weight, eta: null };
  if (weight === null) return { ...projection, reached: false };
  const reached =
    goal.mode === "maintain"
      ? Math.abs(weight - target) <= 0.7
      : goalRate(goal, weight, target) === 0;
  if (goal.mode === "maintain" || reached) return { ...projection, reached };
  // The pace is a share of body weight, so each week's step shrinks on a cut.
  let kg = weight,
    weeks = 0;
  while (weeks < 520) {
    const step = (kg * goal.pace) / 100,
      left = Math.abs(target - kg);
    if (step > 0 && left <= step) {
      weeks += left / step;
      break;
    }
    weeks++;
    kg += goal.mode === "lose" ? -step : step;
  }
  return {
    ...projection,
    reached,
    eta: weeks < 520 ? shiftDay(today, Math.ceil(weeks * 7)) : null,
  };
}

/** Everything Progress shows, read in one pass per data change. */
export function progressSnapshot(today: string, weights: Weights) {
  const intake = dailyIntake("", today),
    trend = weightTrend(weights),
    goal = currentGoal(),
    coached = !!goal && goal.mode !== "manual";
  let first = today;
  for (const day of intake.keys()) if (day < first) first = day;
  return {
    today,
    /** The first day with food or a status, so earlier weeks stop there. */
    first,
    intake,
    targetOn: targetTimeline(),
    trend,
    coached,
    due: coached ? nextCheckInDay(goal) : null,
    projection: goalProjection(trend, goal, today),
    pace: trendPace(trend),
    expenditure: expenditureFrom(intake, trend, shiftDay(today, -6), today),
  };
}
export type ProgressSnapshot = ReturnType<typeof progressSnapshot>;
