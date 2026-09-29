import { useRef, useState } from "react";
import { View } from "react-native";
import { CalorieShiftPicker, weekdayName } from "@/components/plan/calorie-shift";
import { PaceSlider } from "@/components/plan/pace-slider";
import {
  Choices,
  ErrorText,
  Field,
  Heading,
  Meta,
  Note,
  Panel,
  Value,
  parseDecimal,
  useKitFormat,
  useKitStrings,
} from "@/vector";
import { Editor } from "@/components/ui";
import { useStore } from "@/lib/store";
import { useNutrition, useNutritionQuery } from "@/lib/nutrition-store";
import { createProgram, currentGoal, previewProgram, saveShift } from "@/lib/coaching-store";
import { baseTargetsForDay } from "@/lib/diary";
import { PACES, type Program } from "@/lib/program";
import { localDay, weightTrend } from "@/lib/metrics";
import type { CalorieShift } from "@/lib/nutrition";
import type { Goal } from "@/lib/coaching";

const modes = { lose: "modeCut", maintain: "modeMaintain", gain: "modeBulk" } as const;
const activities = {
  low: "activityLow",
  light: "activityLight",
  moderate: "activityModerate",
  high: "activityHigh",
} as const;
const diets = {
  balanced: "dietBalanced",
  "lower-fat": "dietMoreCarbs",
  "lower-carb": "dietMoreFat",
} as const;

export function ProgramEditor({ close }: { close: () => void }) {
  const { weights, measurements, healthProfile, units, t } = useStore();
  const format = useKitFormat();
  const strings = useKitStrings();
  const { refresh } = useNutrition();
  const existing = useNutritionQuery(currentGoal);
  const saved = existing?.program;
  const factor = units === "metric" ? 1 : 2.2046226218;
  // Prefilled and read in the locale's decimal, so "72,5" round-trips in de and fr.
  const shown = (n: number) => format.editable(n, 1);
  const read = (text: string) => parseDecimal(text, format.tag) ?? NaN;
  const [mode, setMode] = useState<Exclude<Goal["mode"], "manual">>(
    existing?.mode === "manual" ? "maintain" : (existing?.mode ?? "lose")
  );
  // A cut starts at the low end of its recommended band, a bulk at the top of its own.
  const [pace, setPace] = useState<number>(existing?.pace || PACES.lose.best[0]);
  // A first program starts from what Health and the height log already know.
  const [age, setAge] = useState(() => {
    if (saved) return shown(saved.age);
    const birth = healthProfile.birthDate;
    if (!birth) return "";
    const today = localDay();
    const years = Number(today.slice(0, 4)) - Number(birth.slice(0, 4));
    return shown(today.slice(5) < birth.slice(5) ? years - 1 : years);
  });
  const [height, setHeight] = useState(() => {
    if (saved) return shown(saved.heightCm / (units === "metric" ? 1 : 2.54));
    const cm = measurements.find((m) => m.kind === "height")?.values.height;
    return cm ? shown(cm / (units === "metric" ? 1 : 2.54)) : "";
  });
  const [weight, setWeight] = useState(() => {
    const kg = weightTrend(weights).at(-1)?.trend ?? saved?.weightKg;
    return kg ? shown(kg * factor) : "";
  });
  const [target, setTarget] = useState(saved ? shown(saved.targetWeightKg * factor) : "");
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
  const [error, setError] = useState("");
  const locked = useRef(false);
  const kept = {
    ...(protein === "custom" ? { proteinG: custom?.proteinG } : {}),
    ...(diet === "custom" ? { carbPct: custom?.carbPct } : {}),
  };
  const budget = {
    age: read(age),
    heightCm: read(height) * (units === "metric" ? 1 : 2.54),
    weightKg: read(weight) / factor,
    targetWeightKg: read(target) / factor,
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
  const shifted = JSON.stringify(shift) !== JSON.stringify(saved?.shift);
  const onlyShift = !!saved && settings === opened && shifted;
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
  const massUnit = format.unitParts(1, units === "metric" ? "kilogram" : "pound").unit;
  function save() {
    if (locked.current) return;
    try {
      locked.current = true;
      if (onlyShift) saveShift(shift);
      else createProgram(mode, pace, draft);
      refresh();
      close();
    } catch (e) {
      locked.current = false;
      setError(e instanceof Error ? e.message : t("couldNotCreateProgram"));
    }
  }
  return (
    <Editor
      title={t(saved ? "updateYourProgram" : "buildYourProgram")}
      open
      close={close}
      // Anything changed holds the sheet: Cancel or the primary action are the exits.
      dirty={settings !== opened || shifted}
      primary={{
        label: t(onlyShift ? "saveCalorieShifting" : "startThisProgram"),
        onPress: save,
        disabled: !onlyShift && !formula,
      }}
    >
      <Choices
        values={["lose", "maintain", "gain"] as const}
        value={mode}
        onChange={(value) => {
          setMode(value);
          setPace(value === "gain" ? PACES.gain.best[1] : PACES.lose.best[0]);
        }}
        label={(value) => t(modes[value])}
        accessibilityLabel={strings.goal}
      />
      <Field label={t("age")} numeric value={age} onChange={setAge} />
      <Field
        label={t(units === "metric" ? "heightCmField" : "heightInchesField")}
        numeric
        value={height}
        onChange={setHeight}
      />
      <Field
        label={t("startingWeight")}
        unit={massUnit}
        numeric
        value={weight}
        onChange={setWeight}
      />
      <Field
        label={t(mode === "maintain" ? "weightToMaintain" : "goalWeight")}
        unit={massUnit}
        numeric
        value={target}
        onChange={setTarget}
      />
      <View className="gap-2">
        <Heading level={4}>{t("sexForEstimate")}</Heading>
        <Choices
          values={["female", "male"] as const}
          value={formula}
          onChange={setFormula}
          label={(value) => t(value === "female" ? "femaleEquation" : "maleEquation")}
          accessibilityLabel={t("sexForEstimate")}
        />
      </View>
      <View className="gap-2">
        <Heading level={4}>{t("typicalActivity")}</Heading>
        <Choices
          values={["low", "light", "moderate", "high"] as const}
          value={activity}
          onChange={setActivity}
          label={(value) => t(activities[value])}
          accessibilityLabel={t("typicalActivity")}
        />
      </View>
      {mode !== "maintain" && (
        <PaceSlider mode={mode} value={pace} onChange={setPace} weightKg={budget.weightKg} />
      )}
      <View className="gap-2">
        <Heading level={4}>{t("macroPreference")}</Heading>
        <Choices
          values={[
            ...(custom?.carbPct !== undefined ? (["custom"] as const) : []),
            ...(["balanced", "lower-fat", "lower-carb"] as const),
          ]}
          value={diet}
          onChange={setDiet}
          label={(value) =>
            value === "custom"
              ? t("customCarbs", { percent: format.percent((custom?.carbPct ?? 0) / 100) })
              : t(diets[value])
          }
          accessibilityLabel={t("macroPreference")}
        />
      </View>
      <View className="gap-2">
        <Heading level={4}>{t("proteinPerKg")}</Heading>
        <Choices
          values={[...(custom?.proteinG !== undefined ? ["custom"] : []), "1.4", "1.6", "2", "2.2"]}
          value={protein}
          onChange={setProtein}
          label={(value) =>
            value === "custom"
              ? t("customGrams", { value: format.number(custom?.proteinG ?? 0) })
              : t("gramsPerKg", {
                  value: format.number(Number(value), value.includes(".") ? 1 : 0),
                })
          }
          accessibilityLabel={t("proteinPerKg")}
        />
      </View>
      <View className="gap-2">
        <Heading level={4}>{t("checkInDay")}</Heading>
        <Choices
          values={["0", "1", "2", "3", "4", "5", "6"]}
          value={checkDay}
          onChange={setCheckDay}
          label={(value) => weekdayName(format, Number(value), "long")}
          accessibilityLabel={t("checkInDay")}
        />
      </View>
      {preview && (
        <Panel>
          <Panel.Body className="gap-2">
            <Value size="l" value={format.number(preview.calories)} unit={t("kcalPerDay")} />
            {(shift || onlyShift) && (
              <Note>
                {t(
                  onlyShift
                    ? shift
                      ? "currentBudgetWeekly"
                      : "currentBudget"
                    : "averageAcrossWeek"
                )}
              </Note>
            )}
            <Meta
              tone="default"
              items={[
                t("proteinGrams", { value: format.number(preview.protein) }),
                t("carbsGrams", { value: format.number(preview.carbs) }),
                t("fatGrams", { value: format.number(preview.fat) }),
              ]}
            />
          </Panel.Body>
        </Panel>
      )}
      <CalorieShiftPicker value={shift} onChange={setShift} budget={preview} />
      <Note>{t("coachingScopeNote")}</Note>
      <ErrorText message={error} />
    </Editor>
  );
}
