import { useRef, useState } from "react";
import { Keyboard, View } from "react-native";
import { InputGroup } from "heroui-native";
import {
  SystemButton,
  SystemIconButton,
  SystemLabel,
  SystemPanel,
  SystemText as Text,
} from "@/components/system";
import { ErrorText } from "@/components/ui";
import type { WeightEntry } from "@/db";
import { fromKg, weightUnit } from "@/lib/metrics";
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
  const { weights, units, number, date, setPreference, refresh } = useStore();
  const nutrition = useNutrition();
  const [value, setValue] = useState(""),
    [confirming, setConfirming] = useState(false),
    [error, setError] = useState("");
  const locked = useRef(false);
  const unit = weightUnit(units);
  const digits = units === "stone" ? 2 : 1;
  const show = (kg: number) => `${number(fromKg(kg, units), digits)} ${unit}`;
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
      onSaved(entry, `Weight saved · ${show(kg)}`);
    } catch (e) {
      locked.current = false;
      setError(e instanceof Error ? e.message : "Could not save your weight.");
    }
  }
  return (
    <SystemPanel className="p-4">
      <SystemPanel.Body className="gap-3">
        <View className="-my-2 -mr-2 flex-row items-center">
          <SystemLabel className="flex-1 text-accent-soft-foreground">Morning weigh-in</SystemLabel>
          <SystemIconButton
            icon="close"
            iconSize={18}
            color="muted"
            accessibilityLabel="Skip today's weigh-in"
            onPress={() => {
              Keyboard.dismiss();
              setPreference("weighInSkippedDay", today);
            }}
          />
        </View>
        <View className="flex-row items-center gap-2">
          <InputGroup className="flex-1">
            <InputGroup.Input
              value={value}
              onChangeText={(text) => {
                setValue(text);
                setConfirming(false);
                setError("");
              }}
              keyboardType="decimal-pad"
              returnKeyType="done"
              onSubmitEditing={save}
              placeholder="Weight"
              accessibilityLabel={`Weight in ${unit}`}
              className="font-mono text-lg tabular-nums"
              maxFontSizeMultiplier={1.4}
            />
            <InputGroup.Suffix pointerEvents="none">
              <Text className="text-muted">{unit}</Text>
            </InputGroup.Suffix>
          </InputGroup>
          <SystemButton className="min-h-12" isDisabled={!value.trim()} onPress={save}>
            {confirming ? "Save anyway" : "Save"}
          </SystemButton>
        </View>
        {confirming && last ? (
          <Text className="text-sm text-warning" accessibilityLiveRegion="polite">
            Big change from {show(last.weightKg)} on {date(last.measuredAt)}.
          </Text>
        ) : last ? (
          <Text className="text-xs text-muted">
            Last {show(last.weightKg)} · {date(last.measuredAt)}
          </Text>
        ) : null}
        <ErrorText message={error} />
      </SystemPanel.Body>
    </SystemPanel>
  );
}
