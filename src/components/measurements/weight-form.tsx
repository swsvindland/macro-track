import { Field } from "@/components/ui";
import { useStore } from "@/lib/store";
import { MeasurementEditor } from "./measurement-editor";
import type { MeasurementLogState } from "./use-measurement-log";

export function WeightForm({ log }: { log: MeasurementLogState }) {
  const { t } = useStore();
  return (
    <MeasurementEditor title={t("weight")} log={log}>
      <Field
        label={`${t("weight")} (${log.unit})`}
        value={log.inputs.weight ?? ""}
        onChange={(value) => log.setInputs((previous) => ({ ...previous, weight: value }))}
        numeric
        disabled={log.imported}
      />
    </MeasurementEditor>
  );
}
