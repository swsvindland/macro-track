import type { Targets } from "@/lib/nutrition";
import { CoachingPanel } from "./coaching-panel";
import { useState } from "react";
import { View } from "react-native";
import { SystemButton, SystemPanel, SystemText as Text } from "@/components/system";
import { ErrorText, Field, Screen } from "@/components/ui";
import { targetsForDay, saveTargets } from "@/lib/diary";
import { localDay, parseNumber } from "@/lib/metrics";
import { useNutrition, useNutritionQuery } from "@/lib/nutrition-store";
import { useStore } from "@/lib/store";

export function PlanScreen() {
  const targets = useNutritionQuery(() => targetsForDay(localDay()));
  return <PlanContent key={JSON.stringify(targets)} targets={targets} />;
}
function PlanContent({ targets }: { targets: Targets | null }) {
  const { refresh } = useNutrition();
  const { number } = useStore();
  const [values, setValues] = useState(() => ({
    calories: targets ? String(targets.calories) : "",
    protein: targets ? String(targets.protein) : "",
    carbs: targets ? String(targets.carbs) : "",
    fat: targets ? String(targets.fat) : "",
  }));
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const macroCalories =
    parseNumber(values.protein) * 4 + parseNumber(values.carbs) * 4 + parseNumber(values.fat) * 9;
  return (
    <Screen title="Plan" subtitle="Your targets, on your terms.">
      <CoachingPanel
        onTargetsChanged={() => {
          const next = targetsForDay(localDay());
          if (next)
            setValues({
              calories: String(next.calories),
              protein: String(next.protein),
              carbs: String(next.carbs),
              fat: String(next.fat),
            });
          setSaved(false);
        }}
      />
      <SystemPanel>
        <SystemPanel.Body className="gap-5">
          <View className="gap-2">
            <Text className="text-xl font-semibold">Daily targets</Text>
            <Text className="text-muted">
              Set the calories and macros you want to follow. Changes start today and keep previous
              days intact.
            </Text>
          </View>
          <Field
            label="Calories (kcal)"
            value={values.calories}
            numeric
            onChange={(value) => {
              setValues((old) => ({ ...old, calories: value }));
              setSaved(false);
            }}
          />
          <View className="gap-4">
            {(["protein", "carbs", "fat"] as const).map((key) => (
              <Field
                key={key}
                label={`${key[0].toUpperCase() + key.slice(1)} (g)`}
                value={values[key]}
                numeric
                onChange={(value) => {
                  setValues((old) => ({ ...old, [key]: value }));
                  setSaved(false);
                }}
              />
            ))}
          </View>
          {Number.isFinite(macroCalories) && (
            <Text className="text-sm text-muted">
              These macros provide approximately {number(macroCalories, 0)} kcal.
            </Text>
          )}
          <ErrorText message={error} />
          {saved && (
            <Text className="text-success" accessibilityLiveRegion="polite">
              Targets saved. You’re ready to log.
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
                refresh();
                setError("");
                setSaved(true);
              } catch (e) {
                setError(e instanceof Error ? e.message : "Couldn't save your targets.");
              }
            }}
          >
            Save targets
          </SystemButton>
        </SystemPanel.Body>
      </SystemPanel>
      <Text className="text-sm text-muted">
        Coaching estimates are approximate, not a measurement of metabolism. They use a 21-day
        weight trend and logged intake with a short-term 7,700 kcal/kg approximation. Water shifts
        and incomplete logs pause adjustments. This is not a long-term weight prediction or a
        clinically validated model.
      </Text>
    </Screen>
  );
}
