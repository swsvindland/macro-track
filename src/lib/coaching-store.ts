import { and, desc, eq, gte, lte } from "drizzle-orm";
import {
  db,
  coachingGoals,
  checkIns,
  diaryDays,
  foodEntries,
  weightEntries,
  nutritionTargets,
} from "@/db";
import { dayOf, localDay } from "./metrics";
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
export function currentReview(day = localDay()) {
  const goal = currentGoal();
  if (!goal) return null;
  const start = shiftDay(day, -21),
    end = shiftDay(day, -1);
  const rows = db
    .select()
    .from(weightEntries)
    .where(
      and(
        gte(weightEntries.measuredAt, shiftDay(start, -1)),
        lte(weightEntries.measuredAt, day + "T23:59:59Z")
      )
    )
    .all();
  return reviewWeek({
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
  });
}
export function nextCheckInDay() {
  const latest = checkInHistory()[0];
  const goal = currentGoal();
  if (!goal) return localDay();
  return [shiftDay(goal.startedDay, 21), latest ? shiftDay(latest.day, 7) : ""].sort().at(-1)!;
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
