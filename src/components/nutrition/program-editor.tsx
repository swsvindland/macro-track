import { useRef, useState } from "react";
import { SystemButton, SystemPanel, SystemText as Text } from "@/components/system";
import { Choices, Editor, ErrorText, Field } from "@/components/ui";
import { useStore } from "@/lib/store";
import { useNutrition, useNutritionQuery } from "@/lib/nutrition-store";
import { createProgram, currentGoal, previewProgram } from "@/lib/coaching-store";
import { type Program } from "@/lib/program";
import { parseNumber, weightTrend } from "@/lib/metrics";
import type { Goal } from "@/lib/coaching";

export function ProgramEditor({ close }: { close: () => void }) {
  const { weights, units, number } = useStore();
  const { refresh } = useNutrition();
  const existing = useNutritionQuery(currentGoal);
  const saved = existing?.program;
  const factor = units === "metric" ? 1 : 2.2046226218;
  const [mode, setMode] = useState<Exclude<Goal["mode"], "manual">>(
    existing?.mode === "manual" ? "maintain" : (existing?.mode ?? "lose")
  );
  const [pace, setPace] = useState(String(existing?.pace || 0.25));
  const [age, setAge] = useState(saved ? String(saved.age) : "");
  const [height, setHeight] = useState(
    saved ? String(saved.heightCm / (units === "metric" ? 1 : 2.54)) : ""
  );
  const [weight, setWeight] = useState(() => {
    const kg = weightTrend(weights).at(-1)?.trend ?? saved?.weightKg;
    return kg ? String(Number((kg * factor).toFixed(1))) : "";
  });
  const [target, setTarget] = useState(
    saved ? String(Number((saved.targetWeightKg * factor).toFixed(1))) : ""
  );
  const [formula, setFormula] = useState<Program["formula"] | "">(saved?.formula ?? "");
  const [activity, setActivity] = useState<Program["activity"]>(saved?.activity ?? "light");
  const [protein, setProtein] = useState(String(saved?.protein ?? 1.6));
  const [diet, setDiet] = useState<Program["diet"]>(saved?.diet ?? "balanced");
  const [checkDay, setCheckDay] = useState(String(saved?.checkInDay ?? 1));
  const [eligible, setEligible] = useState(false);
  const [error, setError] = useState("");
  const locked = useRef(false);
  const draft = {
    age: parseNumber(age),
    heightCm: parseNumber(height) * (units === "metric" ? 1 : 2.54),
    weightKg: parseNumber(weight) / factor,
    targetWeightKg: parseNumber(target) / factor,
    formula: formula as Program["formula"],
    activity,
    protein: Number(protein),
    diet,
    checkInDay: Number(checkDay),
  };
  const preview = useNutritionQuery(() => {
    try {
      return previewProgram(mode, Number(pace), draft).targets;
    } catch {
      return null;
    }
  }, [mode, pace, age, height, weight, target, formula, activity, protein, diet, checkDay, units]);
  return (
    <Editor title={saved ? "Update your program" : "Build your program"} open close={close}>
      <Choices
        values={["lose", "maintain", "gain"] as const}
        value={mode}
        onChange={(value) => {
          setMode(value);
          setPace(".25");
        }}
        label={(value) => ({ lose: "Cut", maintain: "Maintain", gain: "Bulk" })[value]}
      />
      <Field label="Age" numeric value={age} onChange={setAge} />
      <Field
        label={units === "metric" ? "Height (cm)" : "Height (total inches)"}
        numeric
        value={height}
        onChange={setHeight}
      />
      <Field
        label={`Starting weight (${units === "metric" ? "kg" : "lb"})`}
        numeric
        value={weight}
        onChange={setWeight}
      />
      <Field
        label={`${mode === "maintain" ? "Weight to maintain" : "Goal weight"} (${units === "metric" ? "kg" : "lb"})`}
        numeric
        value={target}
        onChange={setTarget}
      />
      <Text className="font-semibold">Sex used by the starting estimate</Text>
      <Choices
        values={["female", "male"] as const}
        value={formula}
        onChange={setFormula}
        label={(value) => (value === "female" ? "Female equation" : "Male equation")}
      />
      <Text className="font-semibold">Typical activity</Text>
      <Choices
        values={["low", "light", "moderate", "high"] as const}
        value={activity}
        onChange={setActivity}
        label={(value) =>
          ({
            low: "Mostly seated",
            light: "Lightly active",
            moderate: "Active",
            high: "Very active",
          })[value]
        }
      />
      {mode !== "maintain" && (
        <>
          <Text className="font-semibold">Weekly pace (% of body weight)</Text>
          <Choices
            values={mode === "gain" ? ["0.1", "0.25"] : ["0.25", "0.5"]}
            value={pace.replace(/^\./, "0.")}
            onChange={setPace}
            label={(value) => `${value}%`}
          />
        </>
      )}
      <Text className="font-semibold">Macro preference</Text>
      <Choices
        values={["balanced", "lower-fat", "lower-carb"] as const}
        value={diet}
        onChange={setDiet}
        label={(value) =>
          ({ balanced: "Balanced", "lower-fat": "More carbs", "lower-carb": "More fat" })[value]
        }
      />
      <Text className="font-semibold">Protein per kg of body weight</Text>
      <Choices
        values={["1.4", "1.6", "2", "2.2"]}
        value={protein}
        onChange={setProtein}
        label={(value) => `${value} g/kg`}
      />
      <Text className="font-semibold">Check-in day</Text>
      <Choices
        values={["0", "1", "2", "3", "4", "5", "6"]}
        value={checkDay}
        onChange={setCheckDay}
        label={(value) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][Number(value)]}
      />
      {preview && (
        <SystemPanel>
          <SystemPanel.Body className="gap-2">
            <Text className="text-3xl font-semibold">{number(preview.calories, 0)} kcal/day</Text>
            <Text>
              {preview.protein} g protein · {preview.carbs} g carbs · {preview.fat} g fat
            </Text>
          </SystemPanel.Body>
        </SystemPanel>
      )}
      <Text className="text-sm text-muted">
        Coaching is for adults who are not pregnant or breastfeeding. Use professionally guided
        manual targets for medical nutrition needs or eating disorder care.
      </Text>
      <SystemButton
        variant="outline"
        onPress={() => setEligible((value) => !value)}
        accessibilityState={{ checked: eligible }}
      >
        {eligible ? "✓ " : ""}This applies to me
      </SystemButton>
      <ErrorText message={error} />
      <SystemButton
        isDisabled={!eligible || !formula}
        onPress={() => {
          if (locked.current) return;
          try {
            locked.current = true;
            createProgram(mode, Number(pace), draft);
            refresh();
            close();
          } catch (e) {
            locked.current = false;
            setError(e instanceof Error ? e.message : "Could not create your program.");
          }
        }}
      >
        Start this program
      </SystemButton>
    </Editor>
  );
}
