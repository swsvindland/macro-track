import { useEffect, useRef, useState } from "react";
import { AppState, View } from "react-native";
import { router } from "expo-router";
import { SystemButton, SystemPanel, SystemText as Text } from "@/components/system";
import { Choices, DateInput, ErrorText, Screen } from "@/components/ui";
import { entriesForDay, targetsForDay, dayStatus, setDayStatus } from "@/lib/diary";
import { logBatch, loggingChoices, undoLog, type LogChoice, type LogReceipt } from "@/lib/fast-log";
import { openCatalogs } from "@/lib/food-catalog";
import { localDay } from "@/lib/metrics";
import { meals, shiftDay, totalNutrients, type DayState, type Meal } from "@/lib/nutrition";
import { timelineGroups, currentFoodTime, mealAtTime } from "@/lib/food-time";
import { useNutrition, useNutritionQuery } from "@/lib/nutrition-store";
import { useStore } from "@/lib/store";
import type { FoodEntry } from "@/db";
import { useMeasurementLog } from "@/components/measurements/use-measurement-log";
import { WeightForm } from "@/components/measurements/weight-form";
import { FoodEditor } from "./food-editor";
import { FastLogger } from "./fast-logger";
import { HomeCheckIn } from "./home-check-in";
import { MealEditor } from "./meal-editor";
import { QuickAdd } from "./quick-add";
import { CopyDay } from "./copy-day";

const statusLabels: Record<DayState, string> = {
  "in-progress": "In progress",
  complete: "Complete",
  partial: "Partial",
  fasting: "Fasting",
};
export function TodayScreen() {
  const { number, date, diaryLayout, hideEmptyHours } = useStore();
  const { refresh } = useNutrition();
  const weight = useMeasurementLog("weight");
  const [today, setToday] = useState(localDay()),
    [day, setDay] = useState(localDay());
  const todayRef = useRef(today);
  const [hour, setHour] = useState(new Date().getHours());
  const [choosingDay, setChoosingDay] = useState(false),
    [more, setMore] = useState(false);
  const [editor, setEditor] = useState<FoodEntry | null>(null);
  const [logger, setLogger] = useState<{
    time?: string;
    meal?: Meal;
    start?: "search" | "barcode" | "meals";
  } | null>(null);
  const [quick, setQuick] = useState(false),
    [copying, setCopying] = useState(false);
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState<{ message: string; receipt?: LogReceipt } | null>(null);
  const [mealEditor, setMealEditor] = useState<{
    source: { day: string; meal: Meal; group?: string };
    meal: Meal;
  } | null>(null);
  const quickLocks = useRef(new Set<string>());
  useEffect(() => {
    const warm = setTimeout(() => {
      void openCatalogs().catch(() => {});
    }, 300);
    function checkDay() {
      setHour(new Date().getHours());
      const current = localDay(),
        previous = todayRef.current;
      if (previous === current) return;
      todayRef.current = current;
      setToday(current);
      setDay((selected) => (selected === previous ? current : selected));
      setFeedback(null);
    }
    const timer = setInterval(checkDay, 60000);
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") checkDay();
    });
    return () => {
      clearTimeout(warm);
      clearInterval(timer);
      sub.remove();
    };
  }, []);
  const { entries, targets, status, picks } = useNutritionQuery(() => ({
    entries: entriesForDay(day),
    targets: targetsForDay(day),
    status: dayStatus(day),
    picks: loggingChoices(`${String(hour).padStart(2, "0")}:00`).quick,
  }));
  const groups =
    diaryLayout === "timeline"
      ? timelineGroups(entries, hideEmptyHours, day === today)
      : meals.map((meal) => ({
          key: meal,
          title: meal,
          meal,
          group: undefined,
          time: currentFoodTime(),
          entries: entries.filter((entry) => entry.meal === meal),
        }));
  const totals = totalNutrients(entries.map((entry) => entry.nutrients));
  const remaining = targets ? targets.calories - totals.calories : null;
  function logged(receipt: LogReceipt, name?: string) {
    setDay(receipt.day);
    setFeedback({
      message: `${name ?? `${receipt.entries.length} ${receipt.entries.length === 1 ? "food" : "foods"}`} logged. You’re all set.`,
      receipt,
    });
    setError("");
  }
  function quickLog(choice: LogChoice) {
    if (quickLocks.current.has(choice.key)) return;
    quickLocks.current.add(choice.key);
    setTimeout(() => quickLocks.current.delete(choice.key), 900);
    try {
      const receipt = logBatch(choice.items, { day, time: currentFoodTime() });
      refresh();
      logged(receipt, choice.title);
    } catch (e) {
      quickLocks.current.delete(choice.key);
      setError(e instanceof Error ? e.message : "Could not log this food.");
    }
  }
  function updateStatus(value: DayState) {
    try {
      setDayStatus(day, value);
      refresh();
      setError("");
      setFeedback({
        message:
          value === "complete"
            ? "Day complete. You’re all set."
            : `Day marked ${statusLabels[value].toLowerCase()}.`,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update this day.");
    }
  }
  return (
    <>
      <Screen
        compact
        title={day === today ? "Today" : "Food diary"}
        action={
          <SystemButton variant="ghost" onPress={() => router.push("/settings")}>
            Settings
          </SystemButton>
        }
        footer={
          <View className="gap-2">
            <ErrorText message={error} />
            {feedback && (
              <View className="flex-row items-center gap-2 rounded-2xl bg-accent-soft px-3 py-2">
                <Text className="flex-1 text-sm" accessibilityLiveRegion="polite">
                  {feedback.message}
                </Text>
                {feedback.receipt ? (
                  <SystemButton
                    variant="ghost"
                    onPress={() => {
                      try {
                        undoLog(feedback.receipt!);
                        refresh();
                        setFeedback({ message: "Log undone." });
                        setError("");
                      } catch (e) {
                        setError(e instanceof Error ? e.message : "Could not undo.");
                      }
                    }}
                  >
                    Undo
                  </SystemButton>
                ) : (
                  <SystemButton variant="ghost" onPress={() => setFeedback(null)}>
                    Done
                  </SystemButton>
                )}
              </View>
            )}
            <View className="flex-row gap-2">
              <SystemButton className="flex-1" onPress={() => setLogger({})}>
                Log a meal
              </SystemButton>
              <SystemButton variant="secondary" onPress={() => setLogger({ start: "barcode" })}>
                Scan
              </SystemButton>
            </View>
          </View>
        }
      >
        <SystemPanel className="p-4">
          <SystemPanel.Body className="gap-3">
            <View className="flex-row items-center justify-between gap-3">
              <View className="flex-1 gap-1">
                <Text className="text-sm text-muted">
                  {remaining === null
                    ? "Calories eaten"
                    : remaining >= 0
                      ? "Calories left"
                      : "Above target"}
                </Text>
                <Text className="text-4xl font-semibold tabular-nums">
                  {number(Math.abs(remaining ?? totals.calories), 0)}{" "}
                  <Text className="text-base text-muted">kcal</Text>
                </Text>
              </View>
              <SystemButton variant="ghost" onPress={() => setChoosingDay((value) => !value)}>
                {day === today ? date(today) : date(day)}
              </SystemButton>
            </View>
            {targets ? (
              <Text className="text-sm text-muted">
                {number(totals.calories, 0)} eaten · {number(targets.calories, 0)} target
              </Text>
            ) : (
              <SystemButton
                variant="ghost"
                className="self-start px-0"
                onPress={() => router.push("/(tabs)/plan")}
              >
                Build your calorie & macro plan
              </SystemButton>
            )}
            <View className="flex-row gap-3">
              {(["protein", "carbs", "fat"] as const).map((key) => (
                <View key={key} className="flex-1 gap-1">
                  <Text className="text-xs text-muted">{key[0].toUpperCase() + key.slice(1)}</Text>
                  <Text className="font-semibold tabular-nums">
                    {number(totals[key], 0)}
                    <Text className="text-xs text-muted">
                      {targets ? ` / ${number(targets[key], 0)} g` : " g"}
                    </Text>
                  </Text>
                  {targets && targets[key] > 0 && (
                    <View
                      className="h-1 rounded-full bg-surface-tertiary"
                      accessibilityRole="progressbar"
                      accessibilityLabel={key}
                      accessibilityValue={{
                        min: 0,
                        max: targets[key],
                        now: Math.min(totals[key], targets[key]),
                      }}
                    >
                      <View
                        className="h-1 rounded-full bg-accent"
                        style={{ width: `${Math.min(100, (totals[key] / targets[key]) * 100)}%` }}
                      />
                    </View>
                  )}
                </View>
              ))}
            </View>
          </SystemPanel.Body>
        </SystemPanel>
        {choosingDay && (
          <View className="gap-2">
            <DateInput
              label="Diary date"
              value={day}
              onChange={(value) => {
                setDay(value);
                setChoosingDay(false);
                setFeedback(null);
              }}
            />
            <View className="flex-row gap-2">
              <SystemButton
                variant="ghost"
                onPress={() => {
                  setDay(shiftDay(day, -1));
                  setFeedback(null);
                }}
              >
                Previous day
              </SystemButton>
              <SystemButton
                variant="ghost"
                isDisabled={day >= today}
                onPress={() => {
                  setDay(shiftDay(day, 1));
                  setFeedback(null);
                }}
              >
                Next day
              </SystemButton>
            </View>
          </View>
        )}
        {day !== today && (
          <SystemButton
            variant="secondary"
            onPress={() => {
              setDay(today);
              setFeedback(null);
            }}
          >
            Back to today
          </SystemButton>
        )}
        {day === today && (
          <HomeCheckIn
            onDone={(message) => setFeedback({ message })}
            onWeighIn={() => weight.launch(null)}
            onReviewLogs={(value) => {
              setDay(value);
              setMore(true);
            }}
          />
        )}
        {!!picks.length && (
          <View className="gap-1">
            <View className="flex-row items-center justify-between">
              <Text className="font-semibold">Log again</Text>
              <SystemButton variant="ghost" onPress={() => setLogger({ start: "meals" })}>
                Saved meals
              </SystemButton>
            </View>
            {picks.map((choice) => (
              <View key={choice.key} className="flex-row items-center gap-2">
                <View className="flex-1 gap-1">
                  <Text numberOfLines={1} className="font-medium">
                    {choice.title}
                  </Text>
                  <Text className="text-xs text-muted">
                    {choice.detail} ·{" "}
                    {number(totalNutrients(choice.items.map((item) => item.nutrients)).calories, 0)}{" "}
                    kcal
                  </Text>
                </View>
                <SystemButton
                  variant="secondary"
                  accessibilityLabel={`Log ${choice.title} again`}
                  onPress={() => quickLog(choice)}
                >
                  Log
                </SystemButton>
              </View>
            ))}
          </View>
        )}
        {!entries.length && !picks.length && (
          <Text className="text-muted">
            Log your first meal below. Your usual foods and portions will be ready here next time.
          </Text>
        )}
        <View className="flex-row items-center justify-between gap-2">
          <SystemButton variant="ghost" className="px-0" onPress={() => setMore((value) => !value)}>
            More options
          </SystemButton>
          <SystemButton
            variant={status === "complete" ? "ghost" : "secondary"}
            isDisabled={!entries.length}
            onPress={() => updateStatus(status === "complete" ? "in-progress" : "complete")}
          >
            {status === "complete" ? "✓ Day complete" : "Finish day"}
          </SystemButton>
        </View>
        {more && (
          <View className="gap-3">
            <View className="flex-row flex-wrap gap-2">
              <SystemButton variant="secondary" onPress={() => setQuick(true)}>
                Quick calories
              </SystemButton>
              <SystemButton variant="secondary" onPress={() => setCopying(true)}>
                Copy a day
              </SystemButton>
              <SystemButton variant="secondary" onPress={() => weight.launch(null)}>
                Weigh in
              </SystemButton>
              <SystemButton variant="secondary" onPress={() => setLogger({ start: "meals" })}>
                Saved meals
              </SystemButton>
            </View>
            <Choices
              values={["in-progress", "complete", "partial", "fasting"] as const}
              value={status}
              label={(value) => statusLabels[value]}
              onChange={updateStatus}
            />
            <Text className="text-xs text-muted">
              Mark complete only when everything for this day is logged. Fiber:{" "}
              {totals.fiber === null ? "incomplete data" : `${number(totals.fiber)} g`} · Sodium:{" "}
              {totals.sodium === null ? "incomplete data" : `${number(totals.sodium, 0)} mg`}
            </Text>
          </View>
        )}
        <Text className="font-semibold">
          {diaryLayout === "timeline" ? "Food timeline" : "Your meals"}
        </Text>
        {groups
          .filter((group) => group.entries.length || !hideEmptyHours)
          .map((group) => (
            <View key={group.key} className="gap-1">
              <View className="flex-row items-center justify-between gap-2">
                <Text className="text-sm font-semibold text-muted">
                  {group.title} ·{" "}
                  {number(
                    totalNutrients(group.entries.map((entry) => entry.nutrients)).calories,
                    0
                  )}{" "}
                  kcal
                </Text>
                <SystemButton
                  variant="ghost"
                  accessibilityLabel={`Add food to ${group.title}`}
                  onPress={() =>
                    setLogger({ meal: group.meal, time: group.time || currentFoodTime() })
                  }
                >
                  Add
                </SystemButton>
              </View>
              {group.entries.map((entry) => (
                <SystemButton
                  key={entry.id}
                  variant="ghost"
                  className="justify-start px-0 py-2"
                  accessibilityLabel={`Edit ${entry.food.name}`}
                  onPress={() => setEditor(entry)}
                >
                  <View className="flex-1 gap-1">
                    <Text numberOfLines={1}>{entry.food.name}</Text>
                    <Text className="text-xs text-muted">
                      {entry.loggedTime ? `${entry.loggedTime} · ` : ""}
                      {entry.portionLabel}
                    </Text>
                  </View>
                  <Text className="text-sm tabular-nums">
                    {number(entry.nutrients.calories, 0)}
                  </Text>
                </SystemButton>
              ))}
              {!!group.entries.length && (
                <SystemButton
                  variant="ghost"
                  className="self-start px-0"
                  onPress={() =>
                    setMealEditor({
                      source: { day, meal: group.meal, group: group.group },
                      meal: group.meal,
                    })
                  }
                >
                  Save / reuse this meal
                </SystemButton>
              )}
            </View>
          ))}
      </Screen>
      {logger && (
        <FastLogger
          initialDay={day}
          initialTime={logger.time}
          initialMeal={logger.meal ?? mealAtTime(currentFoodTime())}
          start={logger.start}
          close={() => setLogger(null)}
          onLogged={(receipt) => logged(receipt)}
        />
      )}
      {editor && <FoodEditor entry={editor} close={() => setEditor(null)} />}
      {quick && (
        <QuickAdd
          day={day}
          close={() => {
            setQuick(false);
          }}
        />
      )}
      {copying && <CopyDay destination={day} close={() => setCopying(false)} />}
      {mealEditor && (
        <MealEditor
          source={mealEditor.source}
          initialDay={today}
          initialMeal={mealEditor.meal}
          close={() => setMealEditor(null)}
          onLogged={setDay}
        />
      )}
      <WeightForm log={weight} />
    </>
  );
}
