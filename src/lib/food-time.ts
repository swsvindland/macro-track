import { meals, type Meal } from "./nutrition";
export function currentFoodTime() {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}
export function validFoodTime(value: string) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}
export function mealAtTime(time: string): Meal {
  const hour = Number(time.slice(0, 2));
  return hour < 11 ? "Breakfast" : hour < 16 ? "Lunch" : hour < 21 ? "Dinner" : "Snacks";
}
export function inFoodGroup(
  entry: { meal: Meal; loggedTime?: string | null },
  meal: Meal,
  group?: string
) {
  if (group === undefined) return entry.meal === meal;
  if (group === "untimed") return entry.meal === meal && !entry.loggedTime;
  return entry.loggedTime?.slice(0, 2) === group;
}
export function timelineGroups<T extends { meal: Meal; loggedTime: string | null }>(
  entries: T[],
  hideEmpty: boolean,
  includeNow: boolean
) {
  const hours = new Set(
    entries.flatMap((entry) => (entry.loggedTime ? [entry.loggedTime.slice(0, 2)] : []))
  );
  if (!hideEmpty) for (let hour = 0; hour < 24; hour++) hours.add(String(hour).padStart(2, "0"));
  if (includeNow || !entries.length) hours.add(currentFoodTime().slice(0, 2));
  const timed = [...hours].sort().map((hour) => ({
    key: hour,
    title: `${hour}:00`,
    group: hour,
    time: `${hour}:00`,
    meal: mealAtTime(`${hour}:00`),
    entries: entries
      .filter((entry) => entry.loggedTime?.slice(0, 2) === hour)
      .sort((a, b) => a.loggedTime!.localeCompare(b.loggedTime!)),
  }));
  const untimed = meals.flatMap((meal) => {
    const rows = entries.filter((entry) => inFoodGroup(entry, meal, "untimed"));
    return rows.length
      ? [
          {
            key: `untimed-${meal}`,
            title: `${meal} · time not set`,
            group: "untimed",
            time: "",
            meal,
            entries: rows,
          },
        ]
      : [];
  });
  return [...timed, ...untimed];
}
/** Minutes since midnight for a valid "HH:MM" time. */
export function clockMinutes(value: string) {
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
}
/** Adds minutes to "HH:MM", clamping at "24:00" so later-than-midnight means "nothing after". */
export function clockPlus(value: string, minutes: number) {
  const total = Math.min(24 * 60, Math.max(0, clockMinutes(value) + minutes));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}
/** Displays a stored 24-hour time in the device's clock style, e.g. "9:05 AM" or "09:05". */
export function formatClock(value: string, locale?: string) {
  const date = new Date(2000, 0, 1, Number(value.slice(0, 2)), Number(value.slice(3, 5)));
  return date.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
}
/**
 * The history window for "usually eaten later" starts an hour after the last meal
 * already eaten today, so a meal that was just logged is not counted again.
 */
export function paceCutoff(entries: { loggedTime: string | null }[], now: string) {
  const last = entries
    .map((row) => row.loggedTime)
    .filter((time): time is string => !!time && time <= now)
    .sort()
    .at(-1);
  const later = last ? clockPlus(last, 60) : now;
  return later > now ? later : now;
}
