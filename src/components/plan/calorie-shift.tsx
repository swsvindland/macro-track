import { useState } from "react";
import { View } from "react-native";
import { useCalendars } from "expo-localization";
import { twMerge } from "tailwind-merge";
import {
  Choices,
  ErrorText,
  Field,
  Heading,
  Label,
  Note,
  SignalCell,
  Text,
  useHaptics,
  useKitFormat,
  type Format,
} from "@/vector";
import { parseNumber } from "@/lib/metrics";
import { coachedWeek, type CalorieShift, type Targets } from "@/lib/nutrition";
import { validateShift } from "@/lib/program";
import { useStore } from "@/lib/store";

const sizes = ["5", "10", "15", "20"];
/** A Sunday, at noon so no time zone moves it: weekday 0 of any week. */
const SUNDAY = new Date(2024, 0, 7, 12);

/** A weekday's name in the locale (0 = Sunday), through the kit formatter. */
export function weekdayName(format: Format, weekday: number, style: "short" | "long") {
  const day = new Date(SUNDAY);
  day.setDate(SUNDAY.getDate() + weekday);
  return style === "long" ? format.weekdayLong(day) : format.weekdayShort(day);
}

/** Weekdays (0 = Sunday) from the locale's first day of the week. */
export function useWeekOrder() {
  // expo-localization counts weekdays from 1 for Sunday.
  const first = (useCalendars()[0]?.firstWeekday ?? 2) - 1;
  return Array.from({ length: 7 }, (_, i) => (first + i) % 7);
}

/** The week a shift makes of a budget, or null when it doesn't fit and the budget applies. */
export function weekOf(targets: Targets, shift: CalorieShift) {
  try {
    return coachedWeek(targets, shift);
  } catch {
    return null;
  }
}

/** Why a shift doesn't fit a budget, or "" when it does. */
function shiftError(shift: CalorieShift, budget: Targets, fallback: string) {
  try {
    validateShift(shift, budget);
    return "";
  } catch (e) {
    return e instanceof Error ? e.message : fallback;
  }
}

/** Each weekday's calories under calorie shifting, higher days marked. */
export function ShiftWeek({ targets, shift }: { targets: Targets; shift: CalorieShift }) {
  const { t } = useStore();
  const format = useKitFormat();
  const order = useWeekOrder();
  const week = weekOf(targets, shift);
  if (!week) return null;
  return (
    <View className="flex-row gap-1">
      {order.map((weekday) => {
        const high = shift.days.includes(weekday),
          kcal = format.number(week[weekday].calories);
        return (
          <View
            key={weekday}
            accessible
            accessibilityLabel={t(high ? "shiftDayHigher" : "shiftDay", {
              day: weekdayName(format, weekday, "long"),
              kcal,
            })}
            className={twMerge(
              "flex-1 items-center gap-0.5 rounded-control border px-0.5 py-2",
              high ? "border-tint" : "border-border"
            )}
          >
            <Label tone={high ? "tint" : "muted"}>{weekdayName(format, weekday, "short")}</Label>
            {/* Seven columns: one line that shrinks before it clips. */}
            <Text
              variant="readoutXS"
              numberOfLines={1}
              adjustsFontSizeToFit
              maxFontSizeMultiplier={1.2}
            >
              {kcal}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

/**
 * The program editor's calorie shifting: higher weekdays and how much more they get, with the
 * week it makes from `budget`. No higher days means no shifting.
 */
export function CalorieShiftPicker({
  value,
  onChange,
  budget,
}: {
  value?: CalorieShift;
  onChange: (shift?: CalorieShift) => void;
  budget: Targets | null;
}) {
  const { t } = useStore();
  const format = useKitFormat();
  const haptics = useHaptics();
  const order = useWeekOrder();
  const [kcal, setKcal] = useState(
    value?.unit === "kcal" && Number.isFinite(value.size) ? String(value.size) : ""
  );
  const days = value?.days ?? [];
  const size = value?.unit === "kcal" ? "kcal" : String(value?.size ?? 10);
  const choices = [...(sizes.includes(size) || size === "kcal" ? sizes : [...sizes, size]), "kcal"];
  const set = (next: number[], choice = size, text = kcal): void =>
    onChange(
      next.length
        ? choice === "kcal"
          ? { days: next, size: parseNumber(text), unit: "kcal" }
          : { days: next, size: Number(choice), unit: "%" }
        : undefined
    );
  // An empty kcal field is still being typed, so it isn't an error yet.
  const typed = value && budget && (value.unit === "%" || kcal.trim()) ? value : null;
  const error = typed && budget ? shiftError(typed, budget, t("chooseSmallerShift")) : "";
  return (
    <View className="gap-3">
      <View className="gap-1">
        <Heading level={4}>{t("calorieShifting")}</Heading>
        <Note>{t("calorieShiftingHelp")}</Note>
      </View>
      {/* Seven signal cells: the check keeps selection from being colour alone. At most six
          days can be higher, so the seventh waits disabled. */}
      <View className="flex-row gap-1">
        {order.map((weekday) => {
          const selected = days.includes(weekday);
          return (
            <SignalCell
              key={weekday}
              selected={selected}
              accessibilityRole="checkbox"
              accessibilityLabel={t("higherCaloriesOn", {
                day: weekdayName(format, weekday, "long"),
              })}
              check
              disabled={!selected && days.length >= 6}
              className="min-w-0 flex-1 flex-col gap-0.5 px-0.5"
              onPress={() => {
                haptics.selection();
                set(
                  selected
                    ? days.filter((day) => day !== weekday)
                    : [...days, weekday].sort((a, b) => a - b)
                );
              }}
            >
              {weekdayName(format, weekday, "short")}
            </SignalCell>
          );
        })}
      </View>
      {value && (
        <>
          <Choices
            values={choices}
            value={size}
            onChange={(choice) => set(days, choice)}
            label={(choice) =>
              choice === "kcal" ? t("kcal") : format.percent(Number(choice) / 100, 0, true)
            }
            accessibilityLabel={t("shiftSize")}
            mono
          />
          {size === "kcal" && (
            <Field
              label={t("extraKcalHigherDays")}
              numeric
              value={kcal}
              onChange={(text) => {
                setKcal(text);
                set(days, "kcal", text);
              }}
            />
          )}
          {typed && budget && !error && <ShiftWeek targets={budget} shift={typed} />}
          <ErrorText message={error} />
        </>
      )}
    </View>
  );
}
