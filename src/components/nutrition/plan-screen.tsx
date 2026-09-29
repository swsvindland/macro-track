import { currentGoal } from "@/lib/coaching-store";
import { router } from "expo-router";
import type { Targets } from "@/lib/nutrition";
import { CoachingPanel } from "./coaching-panel";
import { useState, type ReactNode } from "react";
import { AccessibilityInfo, Platform, View } from "react-native";
import {
  Button,
  Callout,
  ErrorText,
  Field,
  LinkButton,
  Note,
  Panel,
  parseDecimal,
  useKitFormat,
  type Format,
} from "@/vector";
import { Screen } from "@/components/ui";
import { baseTargetsForDay, saveTargets } from "@/lib/diary";
import { localDay } from "@/lib/metrics";
import { useNutrition, useNutritionQuery } from "@/lib/nutrition-store";
import { useStore } from "@/lib/store";

type TargetValues = Record<keyof Targets, string>;

/** The fields open in the locale's decimal ("12,5" in de), which `read` takes back. */
const targetValues = (targets: Targets | null, format: Format): TargetValues => {
  const shown = (key: keyof Targets) => (targets ? format.editable(targets[key], 4) : "");
  return {
    calories: shown("calories"),
    protein: shown("protein"),
    carbs: shown("carbs"),
    fat: shown("fat"),
  };
};
const macroFields = {
  protein: "proteinGramsField",
  carbs: "carbsGramsField",
  fat: "fatGramsField",
} as const;

/** `footer` docks above the tab bar, and the content scrolls clear of it. */
export function PlanScreen({ footer }: { footer?: ReactNode } = {}) {
  const targets = useNutritionQuery(() => baseTargetsForDay(localDay()));
  const goal = useNutritionQuery(currentGoal);
  const { refresh } = useNutrition();
  const { t } = useStore();
  const format = useKitFormat();
  const current = JSON.stringify(targets);
  // Edits belong to the targets they started from, so new targets reseed the form in place
  // instead of remounting the screen, which would scroll to the top and drop focus.
  const [draft, setDraft] = useState<{ from: string; values: TargetValues } | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState("");
  const values = draft?.from === current ? draft.values : targetValues(targets, format);
  const edit = (key: keyof TargetValues) => (value: string) => {
    setDraft((old) => ({
      from: current,
      values: { ...(old?.from === current ? old.values : values), [key]: value },
    }));
    setSaved(null);
  };
  // Typed targets read in the locale's decimal and grouping ("2.200" kcal in de).
  const read = (text: string) => {
    const value = parseDecimal(text, format.tag);
    return value !== null && value >= 0 ? value : NaN;
  };
  const macroCalories = read(values.protein) * 4 + read(values.carbs) * 4 + read(values.fat) * 9;
  const savedMessage = t("targetsSaved");
  return (
    <Screen title={t("plan")} footer={footer}>
      <CoachingPanel
        onTargetsChanged={() => {
          setDraft(null);
          setSaved(null);
        }}
      />
      {!goal?.program && (
        <Panel>
          <Panel.Header title={t("dailyTargets")} />
          <Panel.Body className="gap-4">
            <Field
              label={t("caloriesKcalField")}
              value={values.calories}
              numeric
              onChange={edit("calories")}
            />
            <View className="gap-4">
              {(["protein", "carbs", "fat"] as const).map((key) => (
                <Field
                  key={key}
                  label={t(macroFields[key])}
                  value={values[key]}
                  numeric
                  onChange={edit(key)}
                />
              ))}
            </View>
            {Number.isFinite(macroCalories) && (
              <Note>{t("macrosProvideKcal", { value: format.number(macroCalories) })}</Note>
            )}
            <ErrorText message={error} />
            {saved === current && <Callout tone="success">{savedMessage}</Callout>}
            {/* Secondary: the dock's barcode is the tab's one primary action. */}
            <Button
              variant="secondary"
              onPress={() => {
                try {
                  saveTargets(localDay(), {
                    calories: read(values.calories),
                    protein: read(values.protein),
                    carbs: read(values.carbs),
                    fat: read(values.fat),
                  });
                  setDraft(null);
                  setSaved(JSON.stringify(baseTargetsForDay(localDay())));
                  refresh();
                  setError("");
                  if (Platform.OS === "ios")
                    AccessibilityInfo.announceForAccessibility(savedMessage);
                } catch (e) {
                  setError(e instanceof Error ? e.message : t("couldNotSaveTargets"));
                }
              }}
            >
              {t("saveTargets")}
            </Button>
          </Panel.Body>
        </Panel>
      )}
      <LinkButton icon="forward" onPress={() => router.push("/coaching-method")}>
        {t("coachingMethodTitle")}
      </LinkButton>
    </Screen>
  );
}
