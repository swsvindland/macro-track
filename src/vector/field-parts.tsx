import type { ReactNode } from "react";
import { View } from "react-native";
import { webHidden } from "./provider";
import { Text } from "./text";

// The field anatomy shared by form.tsx and the date and time inputs (dates.tsx / dates.web.tsx), so neither
// imports the other. Not part of the barrel.

/**
 * The field edge (design-system §5.5). HeroUI Input's own base is a borderless white field on Android and a
 * 1.81:1 signal-cyan focus ring and caret on iOS; these win through HeroUI's tailwind-merge. Focus becomes a 2pt
 * tint outline on iOS and a tint border on Android.
 */
export const fieldEdge =
  "border border-field-border android:border android:border-field-border ios:focus:outline-focus android:focus:border-focus";
/**
 * The edge on a TextInput. heroui-native 1.0.10 thinned the Input base from `ios:outline-2` to `ios:outline`, so the
 * 2pt focus ring (§4.5) is restated; it is a no-op on 1.0.8 and 1.0.9. Inputs only: HeroUI gives them a transparent
 * outline to widen, while a Pressable trigger (Select, TimeInput) has no outline colour at rest.
 */
export const inputEdge = `${fieldEdge} ios:outline-2`;
export const invalidEdge =
  "border-danger android:border-danger ios:outline-danger ios:focus:outline-danger android:focus:border-danger";
export const fieldInput = "min-h-11 rounded-control px-3 android:shadow-none rtl:text-right";
/** Caret and selection in text-safe cyan (HeroUI's default is the 1.81:1 signal). */
export const caret = "accent-tint";

/** The label above every control: fieldLabel role, foreground-secondary, sentence case. Never a placeholder. */
export function FieldLabel({ label, accessory }: { label: string; accessory?: ReactNode }) {
  // The control carries the label as its accessibilityLabel, so the visible text is not a second stop.
  const text = (
    <Text
      variant="fieldLabel"
      tone="secondary"
      accessibilityElementsHidden
      importantForAccessibility="no"
      {...webHidden}
    >
      {label}
    </Text>
  );
  return accessory ? (
    <View className="flex-row items-center gap-1.5">
      {text}
      {accessory}
    </View>
  ) : (
    text
  );
}

const pad2 = (n: number) => String(n).padStart(2, "0");
/** Today as YYYY-MM-DD in local time (the store's day key format). */
export const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};
/** YYYY-MM-DD read as a local calendar day (new Date("2026-09-29") would be UTC midnight). */
export const dayToDate = (day: string) => {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
};
/** HH:MM of a Date in local time (a web time input's value). */
export const clockOf = (d: Date) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;

/**
 * Whether a typed YYYY-MM-DD is a whole day within [min, max] (ISO days compare as strings). A browser date input
 * reports every keystroke, so a year typed digit by digit passes through 0002, 0020 and 0203, and its min and max
 * bound only the picker; native's calendar never offers a day outside them.
 */
export const dayInRange = (day: string, min: string, max: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(day) && day >= min && day <= max;

/**
 * A typed HH:MM on the minute wheel's grid: the minutes round to the nearest multiple of `interval` within the
 * hour, as the native wheel offers only those (a browser time input takes any typed minute). null for anything
 * that is not a whole time.
 */
export function onMinuteGrid(
  clock: string,
  interval = 1
): { hours: number; minutes: number } | null {
  const m = /^(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(clock);
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (hours > 23 || minutes > 59) return null;
  const step = Math.max(1, Math.round(interval));
  // The last slot of the hour, so 23:58 on a 5-minute grid is 23:55, not the next day.
  const last = Math.floor(59 / step) * step;
  return { hours, minutes: Math.min(Math.round(minutes / step) * step, last) };
}
