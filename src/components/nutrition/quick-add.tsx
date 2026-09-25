import { useRef, useState } from "react";
import { SystemButton, SystemText as Text } from "@/components/system";
import { Choices, Editor, ErrorText, Field } from "@/components/ui";
import { saveEntry } from "@/lib/diary";
import { parseNumber } from "@/lib/metrics";
import { meals, type Meal } from "@/lib/nutrition";
import { useNutrition } from "@/lib/nutrition-store";

export function QuickAdd({ day, close }: { day: string; close: () => void }) {
  const { refresh } = useNutrition();
  const [name, setName] = useState("");
  const [meal, setMeal] = useState<Meal>("Snacks");
  const [values, setValues] = useState({ calories: "", protein: "", carbs: "", fat: "" });
  const [error, setError] = useState("");
  const locked = useRef(false);
  return (
    <Editor title="Quick add" open close={close}>
      <Text className="text-muted">
        Log a meal estimate or calories from a label. Macros left blank are recorded as 0; fiber and
        sodium stay unknown.
      </Text>
      <Field
        label="Name (optional)"
        value={name}
        onChange={setName}
        placeholder="e.g. Lunch estimate"
      />
      <Choices values={meals} value={meal} onChange={setMeal} />
      {(["calories", "protein", "carbs", "fat"] as const).map((key) => (
        <Field
          key={key}
          label={
            key === "calories" ? "Calories (kcal)" : `${key[0].toUpperCase() + key.slice(1)} (g)`
          }
          numeric
          value={values[key]}
          onChange={(value) => setValues((old) => ({ ...old, [key]: value }))}
        />
      ))}
      <ErrorText message={error} />
      <SystemButton
        onPress={() => {
          if (locked.current) return;
          try {
            if (!values.calories.trim()) throw new Error("Enter calories for this entry.");
            locked.current = true;
            saveEntry({
              day,
              meal,
              amount: 1,
              portionLabel: "1 estimated entry",
              food: {
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
              },
            });
            refresh();
            close();
          } catch (e) {
            locked.current = false;
            setError(e instanceof Error ? e.message : "Could not log this entry.");
          }
        }}
      >
        Add to diary
      </SystemButton>
    </Editor>
  );
}
