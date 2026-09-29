import { View } from "react-native";
import { Field, useKitFormat } from "@/vector";
import { useStore } from "@/lib/store";
import { MeasurementEditor } from "./measurement-editor";
import type { MeasurementLogState } from "./use-measurement-log";

export function HeightForm({ log }: { log: MeasurementLogState }) {
  const { t } = useStore();
  const format = useKitFormat();
  return (
    <MeasurementEditor title={t(log.editing ? "editHeight" : "addHeight")} log={log}>
      {log.imperialHeight ? (
        <View className="flex-row gap-4">
          {(["feet", "inches"] as const).map((part) => (
            <View key={part} className="flex-1">
              <Field
                label={t("height")}
                unit={format.unitParts(1, part === "feet" ? "foot" : "inch").unit}
                value={log.inputs[part] ?? ""}
                onChange={(value) => log.setInputs((previous) => ({ ...previous, [part]: value }))}
                placeholder={format.number(part === "feet" ? 5 : 0)}
                numeric
                disabled={log.imported}
              />
            </View>
          ))}
        </View>
      ) : (
        <Field
          label={t("height")}
          unit={log.unit}
          value={log.inputs.height ?? ""}
          onChange={(value) => log.setInputs((previous) => ({ ...previous, height: value }))}
          numeric
          disabled={log.imported}
        />
      )}
    </MeasurementEditor>
  );
}
