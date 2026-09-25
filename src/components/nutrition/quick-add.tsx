import { useRef, useState } from "react";
import { View } from "react-native";
import { SystemButton } from "@/components/system";
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
  const { diaryLayout } = useStore();
  const [loggedTime, setLoggedTime] = useState(() => time ?? currentFoodTime());
  const [meal, setMeal] = useState<Meal>(() => initialMeal ?? mealAtTime(loggedTime));
  const [name, setName] = useState("");
  const [values, setValues] = useState({ calories: "", protein: "", carbs: "", fat: "" });
  const [error, setError] = useState("");
  const locked = useRef(false);
  function save() {
    if (locked.current) return;
    try {
      if (!values.calories.trim()) throw new Error("Enter calories for this entry.");
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
          calories: parseNumber(values.calories),
          protein: values.protein.trim() ? parseNumber(values.protein) : 0,
          carbs: values.carbs.trim() ? parseNumber(values.carbs) : 0,
          fat: values.fat.trim() ? parseNumber(values.fat) : 0,
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
      />
      <View className="flex-row gap-2">
        {macros.map((key) => (
          <View key={key} className="flex-1">
            <Field
              label={`${key[0].toUpperCase()}${key.slice(1)} (g)`}
              numeric
              value={values[key]}
              onChange={(value) => setValues((old) => ({ ...old, [key]: value }))}
            />
          </View>
        ))}
      </View>
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
