import { currentGoal } from "@/lib/coaching-store";
import { router } from "expo-router";
import type { Targets } from "@/lib/nutrition";
import { CoachingPanel } from "./coaching-panel";
import { useState } from "react";
import { AccessibilityInfo, Platform, View } from "react-native";
import { SystemButton, SystemPanel, SystemText as Text } from "@/components/system";
import { ErrorText, Field, Screen } from "@/components/ui";
import { baseTargetsForDay, saveTargets } from "@/lib/diary";
import { localDay, parseNumber } from "@/lib/metrics";
import { useNutrition, useNutritionQuery } from "@/lib/nutrition-store";
import { useStore } from "@/lib/store";

type TargetValues = Record<keyof Targets, string>;

const targetValues = (targets: Targets | null): TargetValues => ({
  calories: targets ? String(targets.calories) : "",
  protein: targets ? String(targets.protein) : "",
  carbs: targets ? String(targets.carbs) : "",
  fat: targets ? String(targets.fat) : "",
});
const savedMessage = "Targets saved. You’re ready to log.";

export function PlanScreen() {
  const targets = useNutritionQuery(() => baseTargetsForDay(localDay()));
  const goal = useNutritionQuery(currentGoal);
  const { refresh } = useNutrition();
  const { number } = useStore();
  const current = JSON.stringify(targets);
  // Edits belong to the targets they started from, so new targets reseed the form in place
  // instead of remounting the screen, which would scroll to the top and drop focus.
  const [draft, setDraft] = useState<{ from: string; values: TargetValues } | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState("");
  const values = draft?.from === current ? draft.values : targetValues(targets);
  const edit = (key: keyof TargetValues) => (value: string) => {
    setDraft((old) => ({
      from: current,
      values: { ...(old?.from === current ? old.values : values), [key]: value },
    }));
    setSaved(null);
  };
  const macroCalories =
    parseNumber(values.protein) * 4 + parseNumber(values.carbs) * 4 + parseNumber(values.fat) * 9;
  return (
    <Screen title="Plan">
      <CoachingPanel
        onTargetsChanged={() => {
          setDraft(null);
          setSaved(null);
        }}
      />
      {!goal?.program && (
        <SystemPanel className="p-4">
          <SystemPanel.Body className="gap-4">
            <Text className="text-xl font-semibold">Daily targets</Text>
            <Field
              label="Calories (kcal)"
              value={values.calories}
              numeric
              onChange={edit("calories")}
            />
            <View className="gap-4">
              {(["protein", "carbs", "fat"] as const).map((key) => (
                <Field
                  key={key}
                  label={`${key[0].toUpperCase() + key.slice(1)} (g)`}
                  value={values[key]}
                  numeric
                  onChange={edit(key)}
                />
              ))}
            </View>
            {Number.isFinite(macroCalories) && (
              <Text className="text-sm text-muted">
                These macros provide approximately {number(macroCalories, 0)} kcal.
              </Text>
            )}
            <ErrorText message={error} />
            {saved === current && (
              <Text className="text-success" accessibilityLiveRegion="polite">
                {savedMessage}
              </Text>
            )}
            <SystemButton
              onPress={() => {
                try {
                  saveTargets(localDay(), {
                    calories: parseNumber(values.calories),
                    protein: parseNumber(values.protein),
                    carbs: parseNumber(values.carbs),
                    fat: parseNumber(values.fat),
                  });
                  setDraft(null);
                  setSaved(JSON.stringify(baseTargetsForDay(localDay())));
                  refresh();
                  setError("");
                  if (Platform.OS === "ios")
                    AccessibilityInfo.announceForAccessibility(savedMessage);
                } catch (e) {
                  setError(e instanceof Error ? e.message : "Couldn't save your targets.");
                }
              }}
            >
              Save targets
            </SystemButton>
          </SystemPanel.Body>
        </SystemPanel>
      )}
      <SystemButton
        variant="ghost"
        icon="help-circle-outline"
        onPress={() => router.push("/coaching-method")}
      >
        How check-ins work
      </SystemButton>
    </Screen>
  );
}
