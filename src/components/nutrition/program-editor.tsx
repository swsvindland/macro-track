import { useRef, useState } from "react";
import { CalorieShiftPicker } from "@/components/plan/calorie-shift";
import { PaceSlider } from "@/components/plan/pace-slider";
import { SystemButton, SystemPanel, SystemText as Text } from "@/components/system";
import { Choices, Editor, ErrorText, Field } from "@/components/ui";
import { useStore } from "@/lib/store";
import { useNutrition, useNutritionQuery } from "@/lib/nutrition-store";
import { createProgram, currentGoal, previewProgram, saveShift } from "@/lib/coaching-store";
import { baseTargetsForDay } from "@/lib/diary";
import { PACES, type Program } from "@/lib/program";
import { localDay, parseNumber, weightTrend } from "@/lib/metrics";
import type { CalorieShift } from "@/lib/nutrition";
import type { Goal } from "@/lib/coaching";

export function ProgramEditor({ close }: { close: () => void }) {
  const { weights, measurements, healthProfile, units, number } = useStore();
  const { refresh } = useNutrition();
  const existing = useNutritionQuery(currentGoal);
  const saved = existing?.program;
  const factor = units === "metric" ? 1 : 2.2046226218;
  const [mode, setMode] = useState<Exclude<Goal["mode"], "manual">>(
    existing?.mode === "manual" ? "maintain" : (existing?.mode ?? "lose")
  );
  // A cut starts at the low end of its recommended band, a bulk at the top of its own.
  const [pace, setPace] = useState<number>(existing?.pace || PACES.lose.best[0]);
  // A first program starts from what Health and the height log already know.
  const [age, setAge] = useState(() => {
    if (saved) return String(saved.age);
    const birth = healthProfile.birthDate;
    if (!birth) return "";
    const today = localDay();
    const years = Number(today.slice(0, 4)) - Number(birth.slice(0, 4));
    return String(today.slice(5) < birth.slice(5) ? years - 1 : years);
  });
  const [height, setHeight] = useState(() => {
    if (saved) return String(saved.heightCm / (units === "metric" ? 1 : 2.54));
    const cm = measurements.find((m) => m.kind === "height")?.values.height;
    return cm ? String(Number((cm / (units === "metric" ? 1 : 2.54)).toFixed(1))) : "";
  });
  const [weight, setWeight] = useState(() => {
    const kg = weightTrend(weights).at(-1)?.trend ?? saved?.weightKg;
    return kg ? String(Number((kg * factor).toFixed(1))) : "";
  });
  const [target, setTarget] = useState(
    saved ? String(Number((saved.targetWeightKg * factor).toFixed(1))) : ""
  );
  const [formula, setFormula] = useState<Program["formula"] | "">(
    saved?.formula ?? healthProfile.sex ?? ""
  );
  const [activity, setActivity] = useState<Program["activity"]>(saved?.activity ?? "light");
  // Macros set at a check-in stay selected until another choice replaces them.
  const custom = saved?.custom;
  const [protein, setProtein] = useState(
    custom?.proteinG !== undefined ? "custom" : String(saved?.protein ?? 1.6)
  );
  const [diet, setDiet] = useState<Program["diet"] | "custom">(
    custom?.carbPct !== undefined ? "custom" : (saved?.diet ?? "balanced")
  );
  const [checkDay, setCheckDay] = useState(String(saved?.checkInDay ?? 1));
  const [shift, setShift] = useState<CalorieShift | undefined>(saved?.shift);
  const [eligible, setEligible] = useState(false);
  const [error, setError] = useState("");
  const locked = useRef(false);
  const kept = {
    ...(protein === "custom" ? { proteinG: custom?.proteinG } : {}),
    ...(diet === "custom" ? { carbPct: custom?.carbPct } : {}),
  };
  const budget = {
    age: parseNumber(age),
    heightCm: parseNumber(height) * (units === "metric" ? 1 : 2.54),
    weightKg: parseNumber(weight) / factor,
    targetWeightKg: parseNumber(target) / factor,
    formula: formula as Program["formula"],
    activity,
    protein: protein === "custom" ? (saved?.protein ?? 1.6) : Number(protein),
    diet: diet === "custom" ? (saved?.diet ?? "balanced") : diet,
    checkInDay: Number(checkDay),
    ...(Object.keys(kept).length ? { custom: kept } : {}),
  };
  const draft = shift ? { ...budget, shift } : budget;
  // A change to calorie shifting alone keeps today's budget instead of rebuilding it.
  const settings = JSON.stringify([mode, pace, budget]);
  const [opened] = useState(settings);
  const onlyShift =
    !!saved && settings === opened && JSON.stringify(shift) !== JSON.stringify(saved.shift);
  const current = useNutritionQuery(() => baseTargetsForDay(localDay()));
  // The daily budget before shifting, so a shift that doesn't fit shows why in its own section.
  const rebuilt = useNutritionQuery(() => {
    try {
      return previewProgram(mode, pace, budget).targets;
    } catch {
      return null;
    }
  }, [mode, pace, age, height, weight, target, formula, activity, protein, diet, checkDay, units]);
  const preview = onlyShift ? current : rebuilt;
  return (
    <Editor title={saved ? "Update your program" : "Build your program"} open close={close}>
      <Choices
        values={["lose", "maintain", "gain"] as const}
        value={mode}
        onChange={(value) => {
          setMode(value);
          setPace(value === "gain" ? PACES.gain.best[1] : PACES.lose.best[0]);
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
        <PaceSlider mode={mode} value={pace} onChange={setPace} weightKg={budget.weightKg} />
      )}
      <Text className="font-semibold">Macro preference</Text>
      <Choices
        values={[
          ...(custom?.carbPct !== undefined ? (["custom"] as const) : []),
          ...(["balanced", "lower-fat", "lower-carb"] as const),
        ]}
        value={diet}
        onChange={setDiet}
        label={(value) =>
          ({
            custom: `Custom · ${number(custom?.carbPct ?? 0, 0)}% carbs`,
            balanced: "Balanced",
            "lower-fat": "More carbs",
            "lower-carb": "More fat",
          })[value]
        }
      />
      <Text className="font-semibold">Protein per kg of body weight</Text>
      <Choices
        values={[...(custom?.proteinG !== undefined ? ["custom"] : []), "1.4", "1.6", "2", "2.2"]}
        value={protein}
        onChange={setProtein}
        label={(value) =>
          value === "custom" ? `Custom · ${number(custom?.proteinG ?? 0, 0)} g` : `${value} g/kg`
        }
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
            {(shift || onlyShift) && (
              <Text className="text-sm text-muted">
                {onlyShift
                  ? `Your current budget${shift ? ", as a weekly average" : ""}`
                  : "Average across the week"}
              </Text>
            )}
            <Text>
              {preview.protein} g protein · {preview.carbs} g carbs · {preview.fat} g fat
            </Text>
          </SystemPanel.Body>
        </SystemPanel>
      )}
      <CalorieShiftPicker value={shift} onChange={setShift} budget={preview} />
      <Text className="text-sm text-muted">
        Coaching is for adults who are not pregnant or breastfeeding. Use professionally guided
        manual targets for medical nutrition needs or eating disorder care.
      </Text>
      {!onlyShift && (
        <SystemButton
          variant="outline"
          onPress={() => setEligible((value) => !value)}
          accessibilityState={{ checked: eligible }}
        >
          {eligible ? "✓ " : ""}This applies to me
        </SystemButton>
      )}
      <ErrorText message={error} />
      <SystemButton
        isDisabled={!onlyShift && (!eligible || !formula)}
        onPress={() => {
          if (locked.current) return;
          try {
            locked.current = true;
            if (onlyShift) saveShift(shift);
            else createProgram(mode, pace, draft);
            refresh();
            close();
          } catch (e) {
            locked.current = false;
            setError(e instanceof Error ? e.message : "Could not create your program.");
          }
        }}
      >
        {onlyShift ? "Save calorie shifting" : "Start this program"}
      </SystemButton>
    </Editor>
  );
}
