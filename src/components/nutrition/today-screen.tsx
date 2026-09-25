import { QuickAdd } from "./quick-add";
import { CopyDay } from "./copy-day";
import { useEffect, useRef, useState } from "react";
import { AppState, View } from "react-native";
import { router } from "expo-router";
import { SystemButton, SystemPanel, SystemText as Text } from "@/components/system";
import { Choices, DateInput, ErrorText, Screen } from "@/components/ui";
import { entriesForDay, targetsForDay, dayStatus, setDayStatus } from "@/lib/diary";
import { localDay } from "@/lib/metrics";
import { meals, shiftDay, totalNutrients, type DayState, type Meal } from "@/lib/nutrition";
import { useNutrition, useNutritionQuery } from "@/lib/nutrition-store";
import { useStore } from "@/lib/store";
import type { FoodEntry } from "@/db";
import { FoodEditor } from "./food-editor";
import { MealEditor } from "./meal-editor";

const statusLabels: Record<DayState, string> = {
  "in-progress": "In progress",
  complete: "Complete",
  partial: "Partial",
  fasting: "Fasting",
};

export function TodayScreen() {
  const { number, date } = useStore();
  const { refresh } = useNutrition();
  const [today, setToday] = useState(localDay());
  const todayRef = useRef(today);
  const [day, setDay] = useState(localDay());
  const [choosingDay, setChoosingDay] = useState(false);
  const [editor, setEditor] = useState<{ meal: Meal; entry?: FoodEntry } | null>(null);
  const [quick, setQuick] = useState(false);
  const [copying, setCopying] = useState(false);
  const [error, setError] = useState("");
  const [mealEditor, setMealEditor] = useState<{
    source?: { day: string; meal: Meal };
    meal: Meal;
  } | null>(null);
  useEffect(() => {
    function checkDay() {
      const current = localDay();
      const previous = todayRef.current;
      if (previous === current) return;
      todayRef.current = current;
      setToday(current);
      setDay((selected) => (selected === previous ? current : selected));
    }
    const timer = setInterval(checkDay, 60000);
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") checkDay();
    });
    return () => {
      clearInterval(timer);
      sub.remove();
    };
  }, []);
  const { entries, targets, status } = useNutritionQuery(() => ({
    entries: entriesForDay(day),
    targets: targetsForDay(day),
    status: dayStatus(day),
  }));
  const totals = totalNutrients(entries.map((entry) => entry.nutrients));
  return (
    <>
      <Screen
        title={day === today ? "Today" : "Food diary"}
        action={
          <SystemButton variant="ghost" onPress={() => router.push("/settings")}>
            Settings
          </SystemButton>
        }
      >
        <View className="flex-row items-center justify-between gap-1 rounded-2xl bg-surface p-1">
          <SystemButton
            variant="ghost"
            onPress={() => {
              setDay(shiftDay(day, -1));
              setError("");
            }}
          >
            Previous
          </SystemButton>
          <SystemButton
            variant="ghost"
            className="flex-1"
            onPress={() => setChoosingDay(!choosingDay)}
          >
            {date(day)}
          </SystemButton>
          <SystemButton
            variant="ghost"
            isDisabled={day >= today}
            onPress={() => {
              setDay(shiftDay(day, 1));
              setError("");
            }}
          >
            Next
          </SystemButton>
        </View>
        {choosingDay && (
          <DateInput
            label="Diary date"
            value={day}
            onChange={(value) => {
              setDay(value);
              setChoosingDay(false);
            }}
          />
        )}
        <SystemPanel className="p-6">
          <SystemPanel.Body className="gap-6">
            <View className="gap-1">
              <Text className="text-sm text-muted">Calories eaten</Text>
              <Text className="text-5xl font-semibold tabular-nums">
                {number(totals.calories, 0)} <Text className="text-base text-muted">kcal</Text>
              </Text>
              <Text className="text-sm text-muted">
                {targets
                  ? `${number(Math.abs(targets.calories - totals.calories), 0)} kcal ${totals.calories > targets.calories ? "above" : "remaining to"} your ${number(targets.calories, 0)} target`
                  : "Set your daily targets in Plan."}
              </Text>
            </View>
            <View className="flex-row gap-3">
              {(["protein", "carbs", "fat"] as const).map((key) => (
                <View className="flex-1 gap-2" key={key}>
                  <Text className="text-sm text-muted">{key[0].toUpperCase() + key.slice(1)}</Text>
                  <Text className="text-2xl font-semibold tabular-nums">
                    {number(totals[key], 0)}{" "}
                    <Text className="text-xs text-muted">
                      {targets ? `/ ${number(targets[key], 0)} g` : "g"}
                    </Text>
                  </Text>
                  {targets && targets[key] > 0 && (
                    <View
                      className="h-1.5 rounded-full bg-surface-tertiary"
                      accessibilityRole="progressbar"
                      accessibilityValue={{
                        min: 0,
                        max: targets[key],
                        now: Math.min(totals[key], targets[key]),
                      }}
                      accessibilityLabel={key}
                    >
                      <View
                        className="h-1.5 rounded-full bg-accent"
                        style={{ width: `${Math.min(100, (totals[key] / targets[key]) * 100)}%` }}
                      />
                    </View>
                  )}
                </View>
              ))}
            </View>
          </SystemPanel.Body>
        </SystemPanel>
        <View className="flex-row gap-3">
          <SystemButton
            className="flex-1"
            onPress={() =>
              setEditor({
                meal:
                  new Date().getHours() < 11
                    ? "Breakfast"
                    : new Date().getHours() < 16
                      ? "Lunch"
                      : "Dinner",
              })
            }
          >
            Add food
          </SystemButton>
          <SystemButton
            className="flex-1"
            variant="secondary"
            onPress={() => setMealEditor({ meal: "Breakfast" })}
          >
            Saved meals
          </SystemButton>
        </View>
        <View className="flex-row gap-3">
          <SystemButton variant="ghost" className="flex-1" onPress={() => setQuick(true)}>
            Quick add
          </SystemButton>
          <SystemButton variant="ghost" className="flex-1" onPress={() => setCopying(true)}>
            Copy a day
          </SystemButton>
        </View>
        {status === "fasting" && (
          <Text className="text-sm text-muted">
            Marked as fasting. Adding food reopens this day.
          </Text>
        )}
        <View className="flex-row items-center justify-between">
          <Text className="text-xl font-semibold">Your meals</Text>
          <Text className="text-sm text-muted">
            {entries.length} {entries.length === 1 ? "food" : "foods"} logged
          </Text>
        </View>
        {meals.map((meal) => {
          const rows = entries.filter((entry) => entry.meal === meal);
          const mealCalories = rows.reduce((total, item) => total + item.nutrients.calories, 0);
          return (
            <SystemPanel key={meal}>
              <SystemPanel.Body className="gap-3">
                <View className="flex-row items-center justify-between gap-3">
                  <View className="flex-1 gap-1">
                    <Text className="text-lg font-semibold">{meal}</Text>
                    <Text className="text-sm text-muted">
                      {rows.length ? `${number(mealCalories, 0)} kcal` : "Ready when you are"}
                    </Text>
                  </View>
                  <SystemButton
                    variant="secondary"
                    accessibilityLabel={`Add food to ${meal}`}
                    onPress={() => setEditor({ meal })}
                  >
                    Add food
                  </SystemButton>
                </View>
                {rows.map((entry) => (
                  <SystemButton
                    key={entry.id}
                    variant="ghost"
                    className="justify-start px-0 py-3"
                    onPress={() => setEditor({ meal, entry })}
                    accessibilityLabel={`Edit ${entry.food.name}`}
                  >
                    <View className="flex-1 gap-1">
                      <Text numberOfLines={2}>{entry.food.name}</Text>
                      <Text className="text-sm text-muted">{entry.portionLabel}</Text>
                    </View>
                    <Text className="font-semibold tabular-nums text-sm">
                      {number(entry.nutrients.calories, 0)}
                    </Text>
                  </SystemButton>
                ))}
                {!!rows.length && (
                  <SystemButton
                    variant="ghost"
                    className="self-start px-0"
                    onPress={() => setMealEditor({ source: { day, meal }, meal })}
                  >
                    Reuse meal
                  </SystemButton>
                )}
              </SystemPanel.Body>
            </SystemPanel>
          );
        })}
        <View className="gap-3 py-2">
          <Text className="font-semibold">Logging status</Text>
          <Choices
            values={["in-progress", "complete", "partial", "fasting"] as const}
            value={status}
            label={(value) => statusLabels[value]}
            onChange={(value) => {
              try {
                setDayStatus(day, value);
                refresh();
                setError("");
              } catch (e) {
                setError(e instanceof Error ? e.message : "Couldn't update this day.");
              }
            }}
          />
          <Text className="text-sm text-muted">
            Mark a day complete when everything is logged. A partial or blank day won’t be treated
            as zero intake.
          </Text>
          <ErrorText message={error} />
        </View>
      </Screen>
      {quick && <QuickAdd day={day} close={() => setQuick(false)} />}
      {copying && <CopyDay destination={day} close={() => setCopying(false)} />}
      {mealEditor && (
        <MealEditor
          source={mealEditor.source}
          initialDay={mealEditor.source ? today : day}
          initialMeal={mealEditor.meal}
          close={() => setMealEditor(null)}
          onLogged={setDay}
        />
      )}
      {editor && (
        <FoodEditor
          initialDay={day}
          initialMeal={editor.meal}
          entry={editor.entry}
          close={() => setEditor(null)}
        />
      )}
    </>
  );
}
