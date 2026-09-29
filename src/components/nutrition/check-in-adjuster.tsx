import { useState } from "react";
import { AccessibilityInfo, Platform, View } from "react-native";
import {
  Button,
  Field,
  IconButton,
  Value,
  parseDecimal,
  useKitFormat,
  useKitStrings,
} from "@/vector";
import type { Targets } from "@/lib/nutrition";
import { adjustedProgram, programTargets, stepTargets, type Program } from "@/lib/program";
import { useStore } from "@/lib/store";

/** P · C · F, each labelled by its full name above its field. */
const macros = [
  ["protein", "macroProtein"],
  ["carbs", "macroCarbs"],
  ["fat", "macroFat"],
] as const;
const grams = (targets: Targets) => ({
  protein: String(targets.protein),
  carbs: String(targets.carbs),
  fat: String(targets.fat),
});
const STEP = 50;

/**
 * Sets this week's targets by hand; typed grams recount the calories. With a program it starts
 * from the program's macros at the trend weight, and ±50 kcal steps allocate as its next review
 * would, keeping typed protein or split. Otherwise steps keep protein and the carb/fat split.
 */
export function CheckInAdjuster({
  start,
  weight,
  program,
  onSave,
  onCancel,
}: {
  start: Targets;
  /** A program's trend weight, whose protein and fat floor the steps keep. */
  weight?: number;
  program?: Program | null;
  onSave: (targets: Targets) => void;
  onCancel: () => void;
}) {
  const { t } = useStore();
  const format = useKitFormat();
  const strings = useKitStrings();
  const [origin] = useState(() =>
    program && weight !== undefined ? programTargets(start, weight, program) : start
  );
  const [calories, setCalories] = useState(Math.round(origin.calories)),
    [values, setValues] = useState(() => grams(origin)),
    // The program with any typed protein or split, so steps allocate as its next review would.
    [plan, setPlan] = useState(program);
  // Typed grams read in the locale's decimal and grouping; anything else is not a number.
  const read = (text: string) => {
    const value = parseDecimal(text, format.tag);
    return value !== null && value >= 0 ? value : NaN;
  };
  const parsed = {
    protein: read(values.protein),
    carbs: read(values.carbs),
    fat: read(values.fat),
  };
  const valid = Object.values(parsed).every(Number.isFinite);
  const step = t("kcalValue", { value: format.number(STEP) });
  function move(delta: number) {
    if (!valid) return;
    const moved = stepTargets({ calories, ...parsed }, delta, weight);
    const next = plan && weight !== undefined ? programTargets(moved, weight, plan) : moved;
    setCalories(next.calories);
    setValues(grams(next));
    // The live region below only speaks on Android.
    if (Platform.OS === "ios")
      AccessibilityInfo.announceForAccessibility(
        t("spokenMacros", {
          kcal: format.number(next.calories),
          protein: format.number(next.protein),
          carbs: format.number(next.carbs),
          fat: format.number(next.fat),
        })
      );
  }
  function edit(key: keyof typeof values, value: string) {
    const next = { ...values, [key]: value };
    setValues(next);
    const [protein, carbs, fat] = [next.protein, next.carbs, next.fat].map(read);
    if (![protein, carbs, fat].every(Number.isFinite)) return;
    const typed = { calories: Math.round(protein * 4 + carbs * 4 + fat * 9), protein, carbs, fat };
    setCalories(typed.calories);
    if (program && weight !== undefined) setPlan(adjustedProgram(program, typed, weight));
  }
  return (
    <View className="gap-3">
      <View className="flex-row items-center gap-2">
        <IconButton
          icon="remove"
          variant="secondary"
          accessibilityLabel={t("decreaseBy", { amount: step })}
          disabled={!valid || calories - STEP < 1500}
          onPress={() => move(-STEP)}
        />
        <View className="flex-1 items-center" accessibilityLiveRegion="polite">
          <Value
            size="m"
            value={format.number(calories)}
            unit={t("kcalPerDay")}
            maxFontSizeMultiplier={1.4}
          />
        </View>
        <IconButton
          icon="add"
          variant="secondary"
          accessibilityLabel={t("increaseBy", { amount: step })}
          disabled={!valid || calories + STEP > 5000}
          onPress={() => move(STEP)}
        />
      </View>
      <View className="flex-row gap-2">
        {macros.map(([key, label]) => (
          <View key={key} className="flex-1">
            <Field
              label={t(label)}
              unit={t("grams")}
              value={values[key]}
              onChange={(value) => edit(key, value)}
              numeric
              selectTextOnFocus
            />
          </View>
        ))}
      </View>
      {/* Secondary: Home's dock and Plan's dock carry each screen's one primary action. */}
      <View className="flex-row gap-2">
        <Button
          variant="secondary"
          className="flex-1"
          disabled={!valid}
          onPress={() => onSave({ calories, ...parsed })}
        >
          {t("saveTargets")}
        </Button>
        <Button variant="ghost" onPress={onCancel}>
          {strings.cancel}
        </Button>
      </View>
    </View>
  );
}
