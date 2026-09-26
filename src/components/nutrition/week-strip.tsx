import { Pressable, View } from "react-native";
import { useCalendars } from "expo-localization";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { SystemText as Text } from "@/components/system";
import { targetsForDay } from "@/lib/diary";
import { dailyIntake, weekDays, weekStart, type WeekDay } from "@/lib/insights";
import { shortDay } from "@/lib/metrics";
import { shiftDay } from "@/lib/nutrition";
import { useNutritionQuery } from "@/lib/nutrition-store";
import { useStore } from "@/lib/store";
import { Ring } from "./amount-picker";

// Screen readers move weeks from any day, since they can't swipe the strip.
const weekActions = [
  { name: "previous", label: "Previous week" },
  { name: "next", label: "Next week" },
];

/**
 * The selected day's week under Home's header: each day's calories against its target. Tap a
 * day to open it; a swipe moves to the same weekday a week away, stopping at today.
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
  const { number, language } = useStore();
  // expo-localization counts weekdays from 1 for Sunday.
  const first = (useCalendars()[0]?.firstWeekday ?? 2) - 1;
  const start = weekStart(day, first);
  const days = useNutritionQuery(
    () => weekDays(start, dailyIntake(start, shiftDay(start, 6)), targetsForDay),
    [start]
  );
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
      // A drag goes by its distance, a short flick by its speed.
      const dragged = Math.abs(translationX) >= 30;
      if (!success || (!dragged && Math.abs(velocityX) < 300)) return;
      move((dragged ? translationX : velocityX) < 0 ? 1 : -1);
    });
  const describe = (item: WeekDay) => {
    const eaten = number(item.eaten.calories, 0),
      target = item.target?.calories;
    return `${shortDay(item.day, language, true)}${item.day === today ? ", today" : ""}: ${
      item.day > today
        ? "upcoming"
        : target
          ? `${eaten} of ${number(target, 0)} kcal`
          : `${eaten} kcal`
    }`;
  };
  return (
    <GestureDetector gesture={swipe}>
      <View className="flex-row gap-1 px-2 pb-1">
        {days.map((item) => {
          const future = item.day > today,
            selected = item.day === day,
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
              className={`flex-1 items-center gap-0.5 rounded-2xl py-1 ${selected ? "bg-surface-secondary" : ""} ${future ? "opacity-40" : ""}`}
            >
              <Text
                className={`text-xs leading-4 ${selected ? "font-semibold text-foreground" : "text-muted"}`}
                maxFontSizeMultiplier={1.2}
              >
                {new Date(`${item.day}T12:00:00`).toLocaleDateString(
                  language === "zh" ? "zh-CN" : language,
                  { weekday: "narrow" }
                )}
              </Text>
              <Ring
                value={target && !future ? item.eaten.calories / target : 0}
                size={32}
                width={3}
              >
                <Text
                  className={`text-sm tabular-nums ${item.day === today ? "font-semibold text-accent-soft-foreground" : ""}`}
                  maxFontSizeMultiplier={1.2}
                >
                  {Number(item.day.slice(8))}
                </Text>
              </Ring>
            </Pressable>
          );
        })}
      </View>
    </GestureDetector>
  );
}
