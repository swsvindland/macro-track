import { eq } from "drizzle-orm";
import { db, weightEntries, type WeightEntry } from "@/db";
import { dayOf, parseNumber, toKg, type Units } from "./metrics";
import { shiftDay } from "./nutrition";

/** Parses a typed weight in the user's units and returns kilograms, or throws. */
export function parseWeight(input: string, units: Units): number {
  const kg = toKg(parseNumber(input), units);
  if (!Number.isFinite(kg) || kg < 20 || kg > 500) throw new Error("Enter a valid weight.");
  return Math.round(kg * 10000) / 10000;
}

/** Records a weigh-in now, the same way the weight editor records today's entry. */
export function logWeight(kg: number): WeightEntry {
  return db
    .insert(weightEntries)
    .values({ weightKg: kg, measuredAt: new Date().toISOString() })
    .returning()
    .get();
}

/** Removes a weigh-in only if it hasn't been edited since it was saved. */
export function undoWeight(saved: WeightEntry) {
  const current = db.select().from(weightEntries).where(eq(weightEntries.id, saved.id)).get();
  if (!current) return;
  if (current.weightKg !== saved.weightKg || current.measuredAt !== saved.measuredAt)
    throw new Error("This weight has changed. Edit it in Progress instead.");
  db.delete(weightEntries).where(eq(weightEntries.id, saved.id)).run();
}

/**
 * The morning card shows from 04:00 until noon to people who weigh in (a weight in
 * the last two weeks) or whose program needs weights, when today has no weight, it
 * wasn't skipped, and Health isn't already delivering recent weights.
 */
export function weighInDue(
  state: { weights: { measuredAt: string }[]; weightsSynced: boolean; weighInSkippedDay: string },
  today: string,
  hour: number,
  coached: boolean
) {
  const recent = shiftDay(today, -14);
  return (
    hour >= 4 &&
    hour < 12 &&
    !state.weightsSynced &&
    state.weighInSkippedDay !== today &&
    (coached || state.weights.some((row) => dayOf(row.measuredAt) >= recent)) &&
    !state.weights.some((row) => dayOf(row.measuredAt) === today)
  );
}

/** Flags a likely typo: more than 3% away from a weigh-in in the previous two weeks. */
export function unusualWeight(
  kg: number,
  last: { weightKg: number; measuredAt: string } | undefined,
  since: string
) {
  return (
    !!last && dayOf(last.measuredAt) >= since && Math.abs(kg - last.weightKg) / last.weightKg > 0.03
  );
}
