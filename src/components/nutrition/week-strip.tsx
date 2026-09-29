import { Pressable, View } from "react-native";
import { useCalendars } from "expo-localization";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { LinkButton, Note, Text, useIsRTL, useKitFormat } from "@/vector";
import { targetsForDay } from "@/lib/diary";
import { dailyIntake, weekDays, weekStart, type WeekDay } from "@/lib/insights";
import { shortDay } from "@/lib/metrics";
import { shiftDay } from "@/lib/nutrition";
import { useNutritionQuery } from "@/lib/nutrition-store";
import { useStore } from "@/lib/store";
import { Ring } from "./amount-picker";

/** A diary day as a local calendar date, at noon so no time zone moves it. */
const dateOf = (day: string) => new Date(`${day}T12:00:00`);

/**
 * The selected day's week under Home's header: each day's calories against its target. Tap a
 * day to open it; a swipe moves to the same weekday a week away, stopping at today. A mark
 * sits under today, and any other week names its dates with a link straight back.
 */
export function WeekStrip({
  day,
  today,
  onChange,
}: {
  day: string;
  today: string;
  onChange: (day: string) => void;
}) {
  const { t } = useStore();
  const format = useKitFormat();
  const isRTL = useIsRTL();
  // expo-localization counts weekdays from 1 for Sunday.
  const first = (useCalendars()[0]?.firstWeekday ?? 2) - 1;
  const start = weekStart(day, first);
  const days = useNutritionQuery(
    () => weekDays(start, dailyIntake(start, shiftDay(start, 6)), targetsForDay),
    [start]
  );
  // Screen readers move weeks from any day, since they can't swipe the strip.
  const weekActions = [
    { name: "previous", label: t("previousWeek") },
    { name: "next", label: t("nextWeek") },
  ];
  function move(weeks: number) {
    if (weeks > 0 && shiftDay(start, 7) > today) return;
    const next = shiftDay(day, 7 * weeks);
    onChange(next > today ? today : next);
  }
  const swipe = Gesture.Pan()
    .runOnJS(true)
    .activeOffsetX([-15, 15])
    .failOffsetY([-10, 10])
    .onEnd(({ translationX, velocityX }, success) => {
      // A drag goes by its distance, a short flick by its speed. The strip mirrors in RTL, so
      // the gesture does too: swiping toward the end edge always goes back in time.
      const dragged = Math.abs(translationX) >= 30;
      if (!success || (!dragged && Math.abs(velocityX) < 300)) return;
      const toStart = (dragged ? translationX : velocityX) * (isRTL ? -1 : 1) < 0;
      move(toStart ? 1 : -1);
    });
  const end = shiftDay(start, 6),
    away = end < today;
  const describe = (item: WeekDay) => {
    const name = shortDay(item.day, format.tag, true);
    const when = item.day === today ? t("dayToday", { day: name }) : name;
    const target = item.target?.calories;
    return item.day > today
      ? t("weekDayUpcoming", { day: when })
      : target
        ? t("weekDayOfTarget", {
            day: when,
            eaten: format.number(item.eaten.calories),
            target: format.number(target),
          })
        : t("weekDayEaten", { day: when, eaten: format.number(item.eaten.calories) });
  };
  return (
    <GestureDetector gesture={swipe}>
      <View>
        {away && (
          <View className="flex-row items-center justify-between gap-3 ps-3">
            <Note className="shrink">{format.dateRange(dateOf(start), dateOf(end))}</Note>
            <LinkButton accessibilityLabel={t("backToToday")} onPress={() => onChange(today)}>
              {t("today")}
            </LinkButton>
          </View>
        )}
        <View className="flex-row gap-1 px-2 pb-1">
          {days.map((item) => {
            const future = item.day > today,
              selected = item.day === day,
              isToday = item.day === today,
              target = item.target?.calories;
            return (
              <Pressable
                key={item.day}
                disabled={future}
                accessibilityRole="button"
                accessibilityLabel={describe(item)}
                accessibilityState={{ selected, disabled: future }}
                accessibilityActions={weekActions}
                onAccessibilityAction={({ nativeEvent }) =>
                  move(nativeEvent.actionName === "next" ? 1 : -1)
                }
                onPress={() => onChange(item.day)}
                className={`flex-1 items-center gap-0.5 rounded-control py-1 ${selected ? "bg-surface-secondary" : ""} ${future ? "opacity-disabled" : ""}`}
              >
                <Text
                  variant="caption"
                  tone={selected ? "default" : "muted"}
                  maxFontSizeMultiplier={1.2}
                >
                  {format.weekdayNarrow(dateOf(item.day))}
                </Text>
                <Ring
                  value={target && !future ? item.eaten.calories / target : 0}
                  size={32}
                  width={3}
                >
                  <Text
                    variant="readoutXS"
                    tone={isToday ? "tint" : "default"}
                    maxFontSizeMultiplier={1.2}
                  >
                    {format.number(Number(item.day.slice(8)))}
                  </Text>
                </Ring>
                {/* Today's mark: a 4pt square in the text-safe cyan. */}
                <View className={`size-1 rounded-mark ${isToday ? "bg-tint" : ""}`} />
              </Pressable>
            );
          })}
        </View>
      </View>
    </GestureDetector>
  );
}
