import { useRef, useState } from "react";
import { Keyboard, View } from "react-native";
import { Button, Callout, ErrorText, Field, IconButton, Meta, Panel, useKitFormat } from "@/vector";
import type { WeightEntry } from "@/db";
import { formatWeight, massUnit } from "@/lib/metrics";
import { shiftDay } from "@/lib/nutrition";
import { useNutrition } from "@/lib/nutrition-store";
import { useStore } from "@/lib/store";
import { logWeight, parseWeight, unusualWeight } from "@/lib/weigh-in";

/** Two taps from Home: type the scale reading, Save. */
export function WeighInCard({
  today,
  onSaved,
}: {
  today: string;
  onSaved: (entry: WeightEntry, message: string) => void;
}) {
  const { weights, units, date, setPreference, refresh, t } = useStore();
  const format = useKitFormat();
  const nutrition = useNutrition();
  const [value, setValue] = useState(""),
    [confirming, setConfirming] = useState(false),
    [error, setError] = useState("");
  const locked = useRef(false);
  const show = (kg: number) => formatWeight(kg, units, format);
  const last = weights.find((row) => !row.excluded);
  function save() {
    if (locked.current || !value.trim()) return;
    try {
      const kg = parseWeight(value, units);
      if (!confirming && unusualWeight(kg, last, shiftDay(today, -14))) {
        setConfirming(true);
        return;
      }
      locked.current = true;
      const entry = logWeight(kg);
      Keyboard.dismiss();
      refresh();
      nutrition.refresh();
      onSaved(entry, t("weightSaved", { weight: show(kg) }));
    } catch (e) {
      locked.current = false;
      setError(e instanceof Error ? e.message : t("couldNotSaveWeight"));
    }
  }
  return (
    <Panel>
      <Panel.Header
        eyebrow={t("morningWeighIn")}
        meta={
          <IconButton
            icon="close"
            accessibilityLabel={t("skipWeighIn")}
            onPress={() => {
              Keyboard.dismiss();
              setPreference("weighInSkippedDay", today);
            }}
          />
        }
      />
      <Panel.Body>
        <View className="flex-row items-end gap-2">
          <View className="flex-1">
            <Field
              label={t("weight")}
              numeric
              unit={format.unitParts(1, massUnit(units)).unit}
              value={value}
              onChange={(text) => {
                setValue(text);
                setConfirming(false);
                setError("");
              }}
              onSubmit={save}
            />
          </View>
          <Button variant="secondary" disabled={!value.trim()} onPress={save}>
            {confirming ? t("saveAnyway") : t("save")}
          </Button>
        </View>
        {confirming && last ? (
          <Callout tone="warning">
            {t("bigWeightChange", { weight: show(last.weightKg), date: date(last.measuredAt) })}
          </Callout>
        ) : last ? (
          <Meta items={[t("lastWeight", { weight: show(last.weightKg) }), date(last.measuredAt)]} />
        ) : null}
        <ErrorText message={error} />
      </Panel.Body>
    </Panel>
  );
}
