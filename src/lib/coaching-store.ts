import {
  initialExpenditure,
  reviewProgram,
  startingTargets,
  validateProgram,
  type Program,
} from "./program";
import { and, desc, gte, lte } from "drizzle-orm";
import {
  db,
  coachingGoals,
  checkIns,
  diaryDays,
  foodEntries,
  weightEntries,
  nutritionTargets,
} from "@/db";
import { dayOf, localDay, weightTrend } from "./metrics";
import { shiftDay } from "./nutrition";
import { targetsForDay } from "./diary";
import { reviewWeek, type Goal } from "./coaching";

export function currentGoal() {
  return db.select().from(coachingGoals).orderBy(desc(coachingGoals.id)).limit(1).get() ?? null;
}
export function checkInHistory() {
  return db.select().from(checkIns).orderBy(desc(checkIns.day)).limit(12).all();
}
export function saveGoal(mode: Goal["mode"], pace: number) {
  if (
    !["manual", "lose", "maintain", "gain"].includes(mode) ||
    !Number.isFinite(pace) ||
    pace < 0 ||
    pace > (mode === "gain" ? 0.25 : 0.5)
  )
    throw new Error("Choose a supported goal and pace.");
  return db
    .insert(coachingGoals)
    .values({
      mode,
      pace: mode === "maintain" || mode === "manual" ? 0 : pace,
      startedDay: localDay(),
    })
    .returning()
    .get();
}
type History = ReturnType<typeof checkInHistory>;
export function currentReview(day = localDay(), goal = currentGoal(), history?: History) {
  if (!goal) return null;
  const start = shiftDay(day, -21),
    end = shiftDay(day, -1);
  const rows = db
    .select()
    .from(weightEntries)
    .where(
      and(
        gte(weightEntries.measuredAt, shiftDay(start, -90)),
        lte(weightEntries.measuredAt, day + "T23:59:59Z")
      )
    )
    .all();
  const input = {
    day,
    goal,
    targets: targetsForDay(day),
    days: db
      .select()
      .from(diaryDays)
      .where(and(gte(diaryDays.day, start), lte(diaryDays.day, end)))
      .all(),
    entries: db
      .select()
      .from(foodEntries)
      .where(and(gte(foodEntries.day, start), lte(foodEntries.day, end)))
      .all(),
    weights: rows.map((row) => ({ day: dayOf(row.measuredAt), kg: row.weightKg })),
  };
  if (goal.program && input.targets) {
    history ??= checkInHistory();
    const completed = history.find(
      (row) => row.day === day && row.goalId === goal.id && row.review.method === 2
    );
    if (completed)
      return {
        ...completed.review,
        proposed: null,
        status: "holding" as const,
        reason:
          "This week’s review is saved. Your next check-in will use fresh logs and your latest normalized weight.",
      };
    const last = history.find((row) => row.review.method === 2 && row.review.expenditure !== null);
    return reviewProgram({
      ...input,
      targets: input.targets,
      program: goal.program,
      priorExpenditure: last?.review.expenditure ?? goal.program.initialExpenditure,
    });
  }
  return reviewWeek(input);
}
export function nextCheckInDay(goal = currentGoal(), history = checkInHistory()) {
  const latest = history[0];
  if (!goal) return localDay();
  if (!goal.program)
    return [shiftDay(goal.startedDay, 21), latest ? shiftDay(latest.day, 7) : ""].sort().at(-1)!;
  let due = latest ? shiftDay(latest.day, 7) : shiftDay(goal.startedDay, 7);
  while (new Date(due + "T12:00:00").getDay() !== goal.program.checkInDay) due = shiftDay(due, 1);
  return due;
}
/**
 * The goal and check-in history read once for Plan and Home. With `onlyWhenDue`, the
 * 21-day review is skipped on the days between check-ins.
 */
export function coachingSnapshot(day = localDay(), { onlyWhenDue = false } = {}) {
  const goal = currentGoal(),
    history = checkInHistory(),
    due = nextCheckInDay(goal, history),
    isDue = due <= day,
    coached = !!goal && goal.mode !== "manual";
  return {
    goal,
    history,
    due,
    isDue,
    targets: targetsForDay(day),
    review: coached && (isDue || !onlyWhenDue) ? currentReview(day, goal, history) : null,
  };
}
export function finishCheckIn(decision: "accepted" | "kept") {
  const day = localDay();
  if (!["accepted", "kept"].includes(decision)) throw new Error("Choose a check-in action.");
  return db.transaction((tx) => {
    const goal = currentGoal(),
      review = currentReview(day),
      current = targetsForDay(day);
    if (!goal || !review || !current || goal.mode === "manual")
      throw new Error("Set up your goal and targets first.");
    if (day < nextCheckInDay()) throw new Error("Your next check-in is not due yet.");
    if (decision === "accepted" && (review.status !== "ready" || !review.proposed))
      throw new Error("Keep your targets while more data is collected.");
    const targets = decision === "accepted" ? review.proposed! : current;
    tx.insert(checkIns).values({ day, goalId: goal.id, decision, review, targets }).run();
    if (decision === "accepted")
      tx.insert(nutritionTargets)
        .values({ effectiveDay: day, targets })
        .onConflictDoUpdate({ target: nutritionTargets.effectiveDay, set: { targets } })
        .run();
    return targets;
  });
}

export function previewProgram(
  mode: Goal["mode"],
  pace: number,
  draft: Omit<Program, "initialExpenditure">
) {
  if (
    !["lose", "maintain", "gain"].includes(mode) ||
    !Number.isFinite(pace) ||
    pace <= 0 ||
    pace > (mode === "gain" ? 0.25 : 0.5)
  )
    throw new Error("Choose a supported goal and pace.");
  const previous = currentGoal();
  const recentWeights = db
    .select()
    .from(weightEntries)
    .where(gte(weightEntries.measuredAt, shiftDay(localDay(), -90)))
    .all();
  const trend = weightTrend(recentWeights.filter((row) => dayOf(row.measuredAt) <= localDay())).at(
    -1
  );
  const weight = trend && trend.day >= shiftDay(localDay(), -7) ? trend.trend : draft.weightKg;
  if (
    (mode === "lose" && draft.targetWeightKg >= weight) ||
    (mode === "gain" && draft.targetWeightKg <= weight)
  )
    throw new Error(
      "Choose a goal weight in the direction of your cut or bulk. For your current weight, choose Maintain."
    );
  const lastEstimate = checkInHistory().find(
    (row) => row.review.method === 2 && row.review.expenditure !== null
  )?.review.expenditure;
  const program: Program = {
    ...draft,
    initialExpenditure:
      lastEstimate ?? previous?.program?.initialExpenditure ?? initialExpenditure(draft),
  };
  validateProgram(program);
  const goal: Goal = { mode, pace: mode === "maintain" ? 0 : pace, startedDay: localDay() };
  const targets = startingTargets(goal, program, weight);
  return { goal, program, targets };
}
export function createProgram(
  mode: Goal["mode"],
  pace: number,
  draft: Omit<Program, "initialExpenditure">
) {
  const { goal, program, targets } = previewProgram(mode, pace, draft);
  db.transaction((tx) => {
    tx.insert(coachingGoals)
      .values({ ...goal, program })
      .run();
    tx.insert(nutritionTargets)
      .values({ effectiveDay: localDay(), targets })
      .onConflictDoUpdate({ target: nutritionTargets.effectiveDay, set: { targets } })
      .run();
  });
  return targets;
}
