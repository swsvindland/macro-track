import { ExtensionStorage } from "@bacons/apple-targets";
import { getLocales } from "expo-localization";
import { localeTag, type DeviceLocale } from "@/vector";
import { entriesForDay, targetsForDay } from "./diary";
import { localDay } from "./metrics";
import { shiftDay, totalNutrients, type Targets } from "./nutrition";
import { translate, type Language, type Message } from "./translations";

/** Shared with the widget extension; must match `appGroup` in targets/widget/Widgets.swift. */
export const widgetAppGroup = "group.dev.svindland.vector.macro";
const storage = new ExtensionStorage(widgetAppGroup);

/** The widget's copy, translated here; names match `WidgetText` in targets/widget/Widgets.swift. */
const widgetText = {
  kcalLeft: "widgetKcalLeft",
  kcalOver: "widgetKcalOver",
  kcalEaten: "widgetKcalEaten",
  kcal: "kcal",
  protein: "macroProtein",
  carbs: "macroCarbs",
  fat: "macroFat",
  proteinShort: "proteinShort",
  carbsShort: "carbsShort",
  fatShort: "fatShort",
  ofTarget: "ofTargetGrams",
  grams: "grams",
  scan: "scan",
  photo: "widgetPhoto",
  scanHint: "scanBarcode",
  photoHint: "widgetPhotoHint",
  title: "widgetTitle",
  openToUpdate: "widgetOpenToUpdate",
} as const satisfies Record<string, Message>;
export type WidgetText = Record<keyof typeof widgetText, string>;

export type WidgetDay = { eaten: Targets; target: Targets | null };
/**
 * Today and the days after it, so the widget turns over at midnight without the app. `locale`
 * formats the widget's numbers; `text` is its copy in the app's language, not the phone's.
 */
export type WidgetSnapshot = { days: Record<string, WidgetDay>; locale: string; text: WidgetText };

const daysAhead = 7;

export function widgetSnapshot(
  today: string,
  read: (day: string) => { eaten: Targets; target: Targets | null },
  language: Language,
  device: readonly DeviceLocale[] = []
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
  const text = Object.fromEntries(
    Object.entries(widgetText).map(([name, key]) => [name, translate(language, key)])
  ) as WidgetText;
  return { days, locale: localeTag(language, device), text };
}

let last = "";
/**
 * Writes today's totals for the Home and Lock Screen widgets, in the app's resolved language.
 * A no-op off iOS.
 */
export function updateWidget(language: Language) {
  try {
    const snapshot = JSON.stringify(
      widgetSnapshot(
        localDay(),
        (day) => {
          const { calories, protein, carbs, fat } = totalNutrients(
            entriesForDay(day).map((entry) => entry.nutrients)
          );
          return { eaten: { calories, protein, carbs, fat }, target: targetsForDay(day) };
        },
        language,
        getLocales()
      )
    );
    // Widget reloads are budgeted by iOS, so only spend one when the numbers or words moved.
    if (snapshot === last) return;
    last = snapshot;
    storage.set("snapshot", snapshot);
    ExtensionStorage.reloadWidget();
  } catch {
    // The widget keeps its last numbers.
  }
}
