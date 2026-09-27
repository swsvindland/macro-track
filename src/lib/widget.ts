import { ExtensionStorage } from "@bacons/apple-targets";
import { entriesForDay, targetsForDay } from "./diary";
import { localDay } from "./metrics";
import { shiftDay, totalNutrients, type Targets } from "./nutrition";

/** Shared with the widget extension; must match `appGroup` in targets/widget/Widgets.swift. */
export const widgetAppGroup = "group.dev.svindland.vector.macro";
const storage = new ExtensionStorage(widgetAppGroup);

export type WidgetDay = { eaten: Targets; target: Targets | null };
/** Today and the days after it, so the widget turns over at midnight without the app. */
export type WidgetSnapshot = { days: Record<string, WidgetDay> };

const daysAhead = 7;

export function widgetSnapshot(
  today: string,
  read: (day: string) => { eaten: Targets; target: Targets | null }
): WidgetSnapshot {
  const days: Record<string, WidgetDay> = {};
  for (let i = 0; i < daysAhead; i++) {
    const day = shiftDay(today, i);
    const { eaten, target } = read(day);
    days[day] = {
      eaten: {
        calories: Math.round(eaten.calories),
        protein: Math.round(eaten.protein),
        carbs: Math.round(eaten.carbs),
        fat: Math.round(eaten.fat),
      },
      target,
    };
  }
  return { days };
}

let last = "";
/** Writes today's totals for the Home and Lock Screen widgets. A no-op off iOS. */
export function updateWidget() {
  try {
    const snapshot = JSON.stringify(
      widgetSnapshot(localDay(), (day) => {
        const { calories, protein, carbs, fat } = totalNutrients(
          entriesForDay(day).map((entry) => entry.nutrients)
        );
        return { eaten: { calories, protein, carbs, fat }, target: targetsForDay(day) };
      })
    );
    // Widget reloads are budgeted by iOS, so only spend one when the numbers moved.
    if (snapshot === last) return;
    last = snapshot;
    storage.set("snapshot", snapshot);
    ExtensionStorage.reloadWidget();
  } catch {
    // The widget keeps its last numbers.
  }
}
