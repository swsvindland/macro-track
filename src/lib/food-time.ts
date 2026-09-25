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
  const timed = [...hours]
    .sort()
    .map((hour) => ({
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
