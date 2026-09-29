import { useRef, useState } from "react";
import { View } from "react-native";
import { SystemButton, SystemText as Text } from "@/components/system";
import { Choices, Editor, ErrorText, Field } from "@/components/ui";
import { logBatch, type LogReceipt } from "@/lib/fast-log";
import { currentFoodTime, mealAtTime } from "@/lib/food-time";
import { parseNumber } from "@/lib/metrics";
import {
  meals,
  scaleNutrients,
  validateFood,
  type Food,
  type Meal,
  type MealItem,
} from "@/lib/nutrition";
import { useNutrition } from "@/lib/nutrition-store";
import { useStore } from "@/lib/store";
import { TimeField } from "./time-field";

const macros = ["protein", "carbs", "fat"] as const;
const macroFields = {
  protein: "proteinGramsField",
  carbs: "carbsGramsField",
  fat: "fatGramsField",
} as const;

/**
 * Logs a calorie estimate straight to the diary, or with `onAdd` hands it back
 * to a meal being built, which then owns the time and meal.
 */
export function QuickAdd({
  day,
  time,
  initialMeal,
  close,
  onLogged,
  onAdd,
}: {
  day: string;
  time?: string;
  initialMeal?: Meal;
  close: () => void;
  onLogged?: (receipt: LogReceipt) => void;
  onAdd?: (item: MealItem) => void;
}) {
  const { refresh } = useNutrition();
  const { diaryLayout, number, t } = useStore();
  const [loggedTime, setLoggedTime] = useState(() => time ?? currentFoodTime());
  const [meal, setMeal] = useState<Meal>(() => initialMeal ?? mealAtTime(loggedTime));
  const [name, setName] = useState("");
  const [values, setValues] = useState({ calories: "", protein: "", carbs: "", fat: "" });
  const [error, setError] = useState("");
  const locked = useRef(false);
  const grams = (key: (typeof macros)[number]) =>
    values[key].trim() ? parseNumber(values[key]) : 0;
  const fromMacros = Math.round(4 * grams("protein") + 4 * grams("carbs") + 9 * grams("fat"));
  const typed = values.calories.trim() ? parseNumber(values.calories) : null;
  // Macros over the calories are always a slip; under them only once all three are in.
  const mismatch =
    typed !== null &&
    Number.isFinite(typed) &&
    fromMacros > 0 &&
    Math.abs(fromMacros - typed) > typed * 0.15 &&
    (fromMacros > typed || macros.every((key) => values[key].trim()));
  function save() {
    if (locked.current) return;
    try {
      if (typed === null && fromMacros === 0)
        throw new Error("Enter calories or macros for this entry.");
      const food: Food = {
        id: `quick:${Date.now()}-${Math.random().toString(36).slice(2)}`,
        name: name.trim() || "Quick add",
        brand: "",
        barcode: null,
        basis: "serving",
        source: "custom",
        sourceVersion: "quick-1",
        portions: [{ label: "1 entry", amount: 1 }],
        nutrients: {
          calories: typed ?? fromMacros,
          protein: grams("protein"),
          carbs: grams("carbs"),
          fat: grams("fat"),
          fiber: null,
          sodium: null,
        },
      };
      validateFood(food);
      const item: MealItem = {
        food,
        amount: 1,
        portionLabel: "1 estimated entry",
        nutrients: scaleNutrients(food, 1),
      };
      locked.current = true;
      if (onAdd) {
        onAdd(item);
        close();
        return;
      }
      let receipt: LogReceipt;
      try {
        receipt = logBatch([item], {
          day,
          time: loggedTime,
          meal: diaryLayout === "timeline" ? undefined : meal,
        });
      } catch (e) {
        locked.current = false;
        throw e;
      }
      refresh();
      close();
      onLogged?.(receipt);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not log this entry.");
    }
  }
  return (
    <Editor
      title="Quick add"
      open
      close={close}
      dirty={!!name.trim() || Object.values(values).some((value) => value.trim())}
      compact
      footer={
        <View className="gap-2">
          <ErrorText message={error} />
          <SystemButton onPress={save}>{onAdd ? "Add to meal" : "Add to diary"}</SystemButton>
        </View>
      }
    >
      <Field
        label="Calories (kcal)"
        numeric
        autoFocus
        value={values.calories}
        onChange={(value) => setValues((old) => ({ ...old, calories: value }))}
        placeholder={fromMacros > 0 ? `${number(fromMacros, 0)} from macros` : undefined}
      />
      <View className="flex-row gap-2">
        {macros.map((key) => (
          <View key={key} className="flex-1">
            <Field
              label={t(macroFields[key])}
              numeric
              value={values[key]}
              onChange={(value) => setValues((old) => ({ ...old, [key]: value }))}
            />
          </View>
        ))}
      </View>
      {mismatch && (
        <Text className="text-sm text-warning" accessibilityLiveRegion="polite">
          {`Macros add up to ${number(fromMacros, 0)} kcal.`}
        </Text>
      )}
      <Field
        label="Name (optional)"
        value={name}
        onChange={setName}
        placeholder="e.g. Lunch estimate"
      />
      {!onAdd && <TimeField value={loggedTime} onChange={setLoggedTime} />}
      {!onAdd && diaryLayout !== "timeline" && (
        <Choices values={meals} value={meal} onChange={setMeal} />
      )}
    </Editor>
  );
}
