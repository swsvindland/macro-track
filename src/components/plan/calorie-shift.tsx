import { useState } from "react";
import { View } from "react-native";
import { useCalendars } from "expo-localization";
import { twMerge } from "tailwind-merge";
import { SystemButton, SystemLabel, SystemText as Text } from "@/components/system";
import { Choices, ErrorText, Field } from "@/components/ui";
import { parseNumber } from "@/lib/metrics";
import { coachedWeek, type CalorieShift, type Targets } from "@/lib/nutrition";
import { validateShift } from "@/lib/program";
import { useStore } from "@/lib/store";

const short = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const names = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const sizes = ["5", "10", "15", "20"];

/** Weekdays (0 = Sunday) from the locale's first day of the week. */
function useWeekOrder() {
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
function shiftError(shift: CalorieShift, budget: Targets) {
  try {
    validateShift(shift, budget);
    return "";
  } catch (e) {
    return e instanceof Error ? e.message : "Choose a smaller shift.";
  }
}

/** Each weekday's calories under calorie shifting, higher days highlighted. */
export function ShiftWeek({ targets, shift }: { targets: Targets; shift: CalorieShift }) {
  const { number } = useStore();
  const order = useWeekOrder();
  const week = weekOf(targets, shift);
  if (!week) return null;
  return (
    <View className="flex-row gap-1">
      {order.map((weekday) => {
        const high = shift.days.includes(weekday),
          kcal = number(week[weekday].calories, 0);
        return (
          <View
            key={weekday}
            accessible
            accessibilityLabel={`${names[weekday]}, ${kcal} kcal${high ? ", higher day" : ""}`}
            className={twMerge(
              "flex-1 items-center gap-0.5 rounded-xl px-0.5 py-2",
              high ? "bg-accent-soft" : "bg-surface-secondary"
            )}
          >
            <SystemLabel className={high ? "text-accent-soft-foreground" : undefined}>
              {short[weekday]}
            </SystemLabel>
            <Text
              className="text-sm font-semibold tabular-nums"
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
  const error = typed && budget ? shiftError(typed, budget) : "";
  return (
    <View className="gap-3">
      <View className="gap-1">
        <Text className="font-semibold">Calorie shifting</Text>
        <Text className="text-sm text-muted">
          Higher days get more; the others get less, so the week stays on budget.
        </Text>
      </View>
      <View className="flex-row gap-1">
        {order.map((weekday) => {
          const selected = days.includes(weekday);
          return (
            <SystemButton
              key={weekday}
              variant="ghost"
              className={twMerge(
                "min-w-0 flex-1 px-0",
                selected ? "bg-accent-soft border-accent-soft" : "bg-surface-secondary"
              )}
              labelClassName={selected ? "text-accent-soft-foreground" : "text-foreground"}
              isDisabled={!selected && days.length >= 6}
              accessibilityLabel={`Higher calories on ${names[weekday]}`}
              accessibilityState={{ selected }}
              onPress={() =>
                set(
                  selected
                    ? days.filter((day) => day !== weekday)
                    : [...days, weekday].sort((a, b) => a - b)
                )
              }
            >
              {short[weekday]}
            </SystemButton>
          );
        })}
      </View>
      {value && (
        <>
          <Choices
            values={choices}
            value={size}
            onChange={(choice) => set(days, choice)}
            label={(choice) => (choice === "kcal" ? "kcal" : `+${choice}%`)}
          />
          {size === "kcal" && (
            <Field
              label="Extra on higher days (kcal)"
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
