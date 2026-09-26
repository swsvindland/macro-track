import { useState } from "react";
import { View } from "react-native";
import { InputGroup } from "heroui-native";
import {
  SystemButton,
  SystemIconButton,
  SystemLabel,
  SystemText as Text,
} from "@/components/system";
import { parseNumber } from "@/lib/metrics";
import type { Targets } from "@/lib/nutrition";
import { adjustedProgram, programTargets, stepTargets, type Program } from "@/lib/program";
import { useStore } from "@/lib/store";

const macros = [
  ["protein", "Protein"],
  ["carbs", "Carbs"],
  ["fat", "Fat"],
] as const;
const grams = (targets: Targets) => ({
  protein: String(targets.protein),
  carbs: String(targets.carbs),
  fat: String(targets.fat),
});

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
  const { number } = useStore();
  const [origin] = useState(() =>
    program && weight !== undefined ? programTargets(start, weight, program) : start
  );
  const [calories, setCalories] = useState(Math.round(origin.calories)),
    [values, setValues] = useState(() => grams(origin)),
    // The program with any typed protein or split, so steps allocate as its next review would.
    [plan, setPlan] = useState(program);
  const parsed = {
    protein: parseNumber(values.protein),
    carbs: parseNumber(values.carbs),
    fat: parseNumber(values.fat),
  };
  const valid = Object.values(parsed).every(Number.isFinite);
  function step(delta: number) {
    if (!valid) return;
    const moved = stepTargets({ calories, ...parsed }, delta, weight);
    const next = plan && weight !== undefined ? programTargets(moved, weight, plan) : moved;
    setCalories(next.calories);
    setValues(grams(next));
  }
  function edit(key: keyof typeof values, value: string) {
    const next = { ...values, [key]: value };
    setValues(next);
    const [protein, carbs, fat] = [next.protein, next.carbs, next.fat].map(parseNumber);
    if (![protein, carbs, fat].every(Number.isFinite)) return;
    const typed = { calories: Math.round(protein * 4 + carbs * 4 + fat * 9), protein, carbs, fat };
    setCalories(typed.calories);
    if (program && weight !== undefined) setPlan(adjustedProgram(program, typed, weight));
  }
  return (
    <View className="gap-3">
      <View className="flex-row items-center gap-2">
        <SystemIconButton
          icon="remove"
          variant="secondary"
          accessibilityLabel="50 kcal less"
          isDisabled={!valid || calories - 50 < 1500}
          onPress={() => step(-50)}
        />
        <Text
          className="flex-1 text-center text-xl font-semibold tabular-nums"
          accessibilityLiveRegion="polite"
          maxFontSizeMultiplier={1.4}
        >
          {number(calories, 0)} kcal/day
        </Text>
        <SystemIconButton
          icon="add"
          variant="secondary"
          accessibilityLabel="50 kcal more"
          isDisabled={!valid || calories + 50 > 5000}
          onPress={() => step(50)}
        />
      </View>
      <View className="flex-row gap-2">
        {macros.map(([key, label]) => (
          <View key={key} className="flex-1 gap-1">
            <SystemLabel>{label}</SystemLabel>
            <InputGroup>
              <InputGroup.Input
                value={values[key]}
                onChangeText={(value) => edit(key, value)}
                keyboardType="number-pad"
                selectTextOnFocus
                accessibilityLabel={`${label} in grams`}
                className="font-mono tabular-nums"
                maxFontSizeMultiplier={1.4}
              />
              <InputGroup.Suffix pointerEvents="none">
                <Text className="text-muted">g</Text>
              </InputGroup.Suffix>
            </InputGroup>
          </View>
        ))}
      </View>
      <View className="flex-row gap-2">
        <SystemButton
          className="flex-1"
          isDisabled={!valid}
          onPress={() => onSave({ calories, ...parsed })}
        >
          Save targets
        </SystemButton>
        <SystemButton variant="secondary" onPress={onCancel}>
          Cancel
        </SystemButton>
      </View>
    </View>
  );
}
