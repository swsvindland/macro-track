import { TimeField } from "./time-field";
import {
  currentFoodTime,
  formatClock,
  inFoodGroup,
  mealAtTime,
  validFoodTime,
} from "@/lib/food-time";
import { useRef, useState } from "react";
import { Alert, View } from "react-native";
import { SystemButton, SystemPanel, SystemText as Text } from "@/components/system";
import { Choices, Editor, ErrorText, Field } from "@/components/ui";
import {
  copyEntries,
  copyMeal,
  deleteSavedMeal,
  entriesForDay,
  listSavedMeals,
  logSavedMeal,
  saveMeal,
  type DiaryReceipt,
} from "@/lib/diary";
import { localDay, parseNumber } from "@/lib/metrics";
import { meals, totalNutrients, type Meal } from "@/lib/nutrition";
import { useNutrition, useNutritionQuery } from "@/lib/nutrition-store";
import { useStore } from "@/lib/store";
import type { SavedMeal } from "@/db";

export function MealEditor({
  source,
  saved,
  initialDay = localDay(),
  initialMeal,
  initialTime,
  close,
  onLogged,
}: {
  /** A meal or hour group of a day, or with `ids`, foods chosen on Home. */
  source?: { day: string; meal: Meal; group?: string; ids?: number[] };
  saved?: SavedMeal;
  initialDay?: string;
  initialMeal?: Meal;
  initialTime?: string;
  close: () => void;
  onLogged?: (receipt: DiaryReceipt) => void;
}) {
  const { refresh } = useNutrition();
  const { number, date, diaryLayout, language } = useStore();
  const available = useNutritionQuery(listSavedMeals);
  const sourceItems = useNutritionQuery(
    () =>
      source
        ? entriesForDay(source.day).filter((entry) =>
            source.ids
              ? source.ids.includes(entry.id)
              : inFoodGroup(entry, source.meal, source.group)
          )
        : [],
    [source?.day, source?.meal, source?.group, source?.ids]
  );
  const [selected, setSelected] = useState(saved);
  const [mode, setMode] = useState<"Save meal" | "Copy meal">("Save meal");
  const [name, setName] = useState(source?.meal ?? "");
  const [day, setDay] = useState(initialDay);
  const [loggedTime, setLoggedTime] = useState(initialTime || currentFoodTime());
  const [meal, setMeal] = useState<Meal>(() => initialMeal ?? mealAtTime(loggedTime));
  const [quantity, setQuantity] = useState("1");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const locked = useRef(false);
  const items = source ? sourceItems : (selected?.items ?? []);
  const totals = totalNutrients(items.map((item) => item.nutrients));
  const factor = source ? 1 : parseNumber(quantity);
  const validFactor = Number.isFinite(factor) && factor > 0 && factor <= 100;
  function submit() {
    if (locked.current) return;
    locked.current = true;
    try {
      if (source && mode === "Save meal") {
        const result = saveMeal(name, source.day, source.meal, source.group, source.ids);
        refresh();
        setSuccess(`${result.name} is ready in your library.`);
      } else {
        const destinationMeal = diaryLayout === "timeline" ? mealAtTime(loggedTime) : meal;
        let receipt: DiaryReceipt;
        if (source?.ids) receipt = copyEntries(source.ids, day, loggedTime, destinationMeal);
        else if (source)
          receipt = copyMeal(
            source.day,
            source.meal,
            day,
            destinationMeal,
            loggedTime,
            source.group
          );
        else if (selected)
          receipt = logSavedMeal(selected.id, day, destinationMeal, factor, loggedTime);
        else throw new Error("Choose a saved meal first.");
        refresh();
        onLogged?.(receipt);
        close();
      }
      setError("");
    } catch (e) {
      locked.current = false;
      setError(e instanceof Error ? e.message : "Couldn't save this meal.");
    }
  }
  const locale = language === "zh" ? "zh-CN" : language;
  const clock = validFoodTime(loggedTime) ? formatClock(loggedTime, locale) : loggedTime;
  return (
    <Editor
      title={
        source?.ids
          ? `Reuse ${source.ids.length === 1 ? "1 food" : `${source.ids.length} foods`}`
          : source
            ? `Reuse ${source.group && source.group !== "untimed" ? formatClock(`${source.group}:00`, locale) : source.meal.toLowerCase()}`
            : selected
              ? selected.name
              : "Saved meals"
      }
      open
      close={close}
    >
      {success ? (
        <View className="gap-4">
          <Text className="text-success" accessibilityLiveRegion="polite">
            {success}
          </Text>
          <SystemButton onPress={close}>Done</SystemButton>
        </View>
      ) : !source && !selected ? (
        <View className="gap-3">
          <Text className="text-muted">Your usual meals, ready in a few taps.</Text>
          {!available.length && (
            <Text className="text-muted">
              Log a meal in your diary, then tap Reuse to save it here.
            </Text>
          )}
          {available.map((item) => (
            <SystemButton
              key={item.id}
              variant="secondary"
              className="justify-start"
              onPress={() => setSelected(item)}
            >
              <View className="flex-1 gap-1">
                <Text className="font-semibold">{item.name}</Text>
                <Text className="text-sm text-muted">
                  {item.items.length} foods ·{" "}
                  {number(totalNutrients(item.items.map((food) => food.nutrients)).calories, 0)}{" "}
                  kcal
                </Text>
              </View>
            </SystemButton>
          ))}
        </View>
      ) : (
        <>
          {source && (
            <Choices
              values={["Save meal", "Copy meal"] as const}
              value={mode}
              onChange={(value) => {
                setMode(value);
                setError("");
              }}
              label={(value) => value}
            />
          )}
          {!source && !saved && (
            <SystemButton
              variant="ghost"
              className="self-start"
              onPress={() => {
                setSelected(undefined);
                setError("");
              }}
            >
              All saved meals
            </SystemButton>
          )}
          <SystemPanel>
            <SystemPanel.Body className="gap-4">
              <View className="gap-1">
                <Text className="text-sm text-muted">
                  {source?.ids
                    ? date(source.day)
                    : source
                      ? `${source.meal} · ${date(source.day)}`
                      : "Meal preview"}
                </Text>
                <Text className="text-3xl font-semibold tabular-nums">
                  {validFactor ? number(totals.calories * factor, 0) : "—"}{" "}
                  <Text className="text-base text-muted">kcal</Text>
                </Text>
                {validFactor && (
                  <Text className="text-sm text-muted">
                    {number(totals.protein * factor)} g protein · {number(totals.carbs * factor)} g
                    carbs · {number(totals.fat * factor)} g fat
                  </Text>
                )}
              </View>
              {items.map((item, index) => (
                <View key={index} className="gap-1">
                  <Text>{item.food.name}</Text>
                  <Text className="text-sm text-muted">
                    {item.portionLabel}
                    {factor !== 1 && validFactor ? ` × ${number(factor, 2)}` : ""}
                  </Text>
                </View>
              ))}
            </SystemPanel.Body>
          </SystemPanel>
          {source && mode === "Save meal" ? (
            <>
              <Field
                label="Meal name"
                value={name}
                onChange={setName}
                placeholder="e.g. My usual breakfast"
              />
              <Text className="text-sm text-muted">
                Keep this combination of foods and portions for next time.
              </Text>
            </>
          ) : (
            <>
              {!source && (
                <Field
                  label="Meal quantity"
                  value={quantity}
                  onChange={setQuantity}
                  numeric
                  placeholder="1"
                />
              )}
              {!source && (
                <Text className="text-sm text-muted">
                  Use 0.5 for half this meal, or 2 for double.
                </Text>
              )}
              <TimeField
                value={loggedTime}
                onChange={setLoggedTime}
                day={day}
                onDayChange={setDay}
              />
              {diaryLayout !== "timeline" && (
                <Choices values={meals} value={meal} onChange={setMeal} label={(value) => value} />
              )}
              <Text className="text-sm text-muted">
                Adds {items.length} food entries to{" "}
                {diaryLayout === "timeline" ? clock : meal.toLowerCase()} on {date(day)}. Existing
                food stays in place.
              </Text>
            </>
          )}
          <ErrorText message={error} />
          <SystemButton onPress={submit}>
            {source && mode === "Save meal"
              ? "Save to library"
              : diaryLayout === "timeline"
                ? `Log at ${clock}`
                : `Add to ${meal.toLowerCase()}`}
          </SystemButton>
          {!source && selected && (
            <SystemButton
              variant="danger-soft"
              onPress={() =>
                Alert.alert(
                  "Remove saved meal?",
                  "Previously logged food will stay in your diary.",
                  [
                    { text: "Cancel", style: "cancel" },
                    {
                      text: "Remove",
                      style: "destructive",
                      onPress: () => {
                        try {
                          deleteSavedMeal(selected.id);
                          refresh();
                          close();
                        } catch {
                          setError("Couldn't remove this meal. Try again.");
                        }
                      },
                    },
                  ]
                )
              }
            >
              Remove from library
            </SystemButton>
          )}
        </>
      )}
    </Editor>
  );
}
