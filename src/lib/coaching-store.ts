import {
  adjustedProgram,
  checkAdjustment,
  initialExpenditure,
  reviewProgram,
  startingTargets,
  validateProgram,
  type Program,
} from "./program";
import { and, asc, desc, eq, gt, gte, isNull, lt, lte } from "drizzle-orm";
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
import { shiftDay, type Targets } from "./nutrition";
import { targetsForDay } from "./diary";
import { reviewWeek, type Goal, type Review } from "./coaching";

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
/** "7/12": the days a review can learn from, against the number it needs. */
export function coverage(review: Review) {
  const [days, needed] =
    review.method === 2 ? [review.observedDays ?? 0, 12] : [review.completeDays, 21];
  return days < needed ? `${days}/${needed}` : String(days);
}
type History = ReturnType<typeof checkInHistory>;
/** A program reviews from its latest check-in's estimate, else the one it was built with. */
function priorExpenditure(startedDay: string, program: Program, history: History) {
  const last = history.find((row) => row.review.method === 2 && row.review.expenditure !== null);
  return last && last.day >= startedDay ? last.review.expenditure! : program.initialExpenditure;
}
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
        // Stored times are UTC; the review day ends at local midnight.
        lt(weightEntries.measuredAt, new Date(`${shiftDay(day, 1)}T00:00:00`).toISOString()),
        eq(weightEntries.excluded, false)
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
    weights: rows.map((row) => ({ day: dayOf(row.measuredAt), kg: row.weightKg, id: row.id })),
  };
  if (goal.program && input.targets) {
    history ??= checkInHistory();
    const review = reviewProgram({
      ...input,
      targets: input.targets,
      program: goal.program,
      priorExpenditure: priorExpenditure(goal.startedDay, goal.program, history),
    });
    // Today's review stays done when the program is edited afterwards, so it isn't blended twice.
    // Its trend, goal pace and any flagged reading follow the weights as they are now.
    const completed = history.find((row) => row.day === day && row.review.method === 2);
    if (!completed) return review;
    const { trendWeightKg, targetWeightKg, desiredWeeklyKg, outlier } = review;
    return {
      ...completed.review,
      trendWeightKg,
      targetWeightKg,
      desiredWeeklyKg,
      outlier,
      proposed: null,
      status: "holding" as const,
      reason:
        "This week’s review is saved. Your next check-in will use fresh logs and your latest normalized weight.",
    };
  }
  return reviewWeek(input);
}
export function nextCheckInDay(goal = currentGoal(), history = checkInHistory()) {
  const latest = history[0];
  if (!goal) return localDay();
  if (!goal.program)
    return [shiftDay(goal.startedDay, 21), latest ? shiftDay(latest.day, 7) : ""].sort().at(-1)!;
  // A new program, or one rebuilt after manual targets, is first due a week after it started,
  // however often it's edited before then.
  const manual = db
    .select({ id: coachingGoals.id })
    .from(coachingGoals)
    .where(isNull(coachingGoals.program))
    .orderBy(desc(coachingGoals.id))
    .limit(1)
    .get();
  const fresh = !latest || (!!manual && manual.id > latest.goalId);
  const started = fresh
    ? (db
        .select({ day: coachingGoals.startedDay })
        .from(coachingGoals)
        .where(gt(coachingGoals.id, manual?.id ?? 0))
        .orderBy(asc(coachingGoals.id))
        .limit(1)
        .get()?.day ?? goal.startedDay)
    : "";
  let due = [latest ? shiftDay(latest.day, 7) : "", fresh ? shiftDay(started, 7) : ""]
    .sort()
    .at(-1)!;
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
/** Trend weight a check-in's macros are checked against. */
const reviewWeight = (review: Review, program: Program) => review.trendWeightKg ?? program.weightKg;
/**
 * Answers a due check-in. "adjusted" saves the given targets instead of the proposal; a program
 * keeps any protein or carb/fat split set by hand for later reviews.
 */
export function finishCheckIn(decision: "accepted" | "kept" | "adjusted", override?: Targets) {
  const day = localDay();
  if (
    !["accepted", "kept", "adjusted"].includes(decision) ||
    (decision === "adjusted") !== !!override
  )
    throw new Error("Choose a check-in action.");
  return db.transaction((tx) => {
    const goal = currentGoal(),
      review = currentReview(day),
      current = targetsForDay(day);
    if (!goal || !review || !current || goal.mode === "manual")
      throw new Error("Set up your goal and targets first.");
    if (day < nextCheckInDay()) throw new Error("Your next check-in is not due yet.");
    if (decision === "accepted" && (review.status !== "ready" || !review.proposed))
      throw new Error("Keep your targets while more data is collected.");
    const program = goal.program;
    const targets =
      decision === "adjusted"
        ? checkAdjustment(override!, program ? reviewWeight(review, program) : undefined)
        : decision === "accepted"
          ? review.proposed!
          : current;
    tx.insert(checkIns)
      .values({
        day,
        goalId: goal.id,
        decision,
        review: { ...review, outlier: undefined },
        targets,
      })
      .run();
    if (decision !== "kept")
      tx.insert(nutritionTargets)
        .values({ effectiveDay: day, targets })
        .onConflictDoUpdate({ target: nutritionTargets.effectiveDay, set: { targets } })
        .run();
    if (decision === "adjusted" && program) {
      const next = adjustedProgram(program, targets, reviewWeight(review, program));
      // A new revision, like a program edit: the check-in above keeps this week's review done.
      if (
        next.custom?.proteinG !== program.custom?.proteinG ||
        next.custom?.carbPct !== program.custom?.carbPct
      )
        tx.insert(coachingGoals)
          .values({ mode: goal.mode, pace: goal.pace, startedDay: day, program: next })
          .run();
    }
    return targets;
  });
}
/**
 * A cut or bulk whose trend has reached its goal weight, so it can switch to Maintain. Not while
 * a flagged weigh-in, likely a misread, still moves the trend.
 */
export function reachedGoal(goal: ReturnType<typeof currentGoal>, review: Review | null) {
  return (
    !!goal?.program &&
    (goal.mode === "lose" || goal.mode === "gain") &&
    !review?.outlier &&
    review?.desiredWeeklyKg === 0 &&
    review.trendWeightKg !== undefined
  );
}
/**
 * Switches a finished cut or bulk to Maintain at its goal weight. On a due check-in this also
 * answers it, and the new program starts from that review's estimate.
 */
export function maintainGoal() {
  const day = localDay();
  const { goal, isDue, review } = coachingSnapshot(day);
  if (!goal?.program || !review || !reachedGoal(goal, review))
    throw new Error("Your trend hasn’t reached your goal weight yet.");
  const weight = reviewWeight(review, goal.program);
  const next: Goal = { mode: "maintain", pace: 0, startedDay: day };
  const program: Program = {
    ...goal.program,
    weightKg: Math.round(weight * 10) / 10,
    initialExpenditure:
      isDue && review.expenditure !== null
        ? review.expenditure
        : priorExpenditure(goal.startedDay, goal.program, checkInHistory()),
  };
  const targets = startingTargets(next, program, weight);
  db.transaction((tx) => {
    if (isDue)
      tx.insert(checkIns)
        .values({
          day,
          goalId: goal.id,
          decision: "adjusted",
          review: { ...review, outlier: undefined },
          targets,
        })
        .run();
    tx.insert(coachingGoals)
      .values({ ...next, program })
      .run();
    tx.insert(nutritionTargets)
      .values({ effectiveDay: day, targets })
      .onConflictDoUpdate({ target: nutritionTargets.effectiveDay, set: { targets } })
      .run();
  });
  return targets;
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
  // An edit keeps the program's running estimate. After manual targets, one reviewed more than
  // eight weeks ago is too old to reuse.
  const history = checkInHistory(),
    recent = shiftDay(localDay(), -56);
  const program: Program = {
    ...draft,
    initialExpenditure: previous?.program
      ? priorExpenditure(previous.startedDay, previous.program, history)
      : (history.find(
          (row) => row.day >= recent && row.review.method === 2 && row.review.expenditure !== null
        )?.review.expenditure ?? initialExpenditure(draft)),
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
