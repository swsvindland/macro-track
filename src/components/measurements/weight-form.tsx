import { Field } from "@/components/ui";
import { useStore } from "@/lib/store";
import { MeasurementEditor } from "./measurement-editor";
import type { MeasurementLogState } from "./use-measurement-log";

export function WeightForm({ log }: { log: MeasurementLogState }) {
  const { t } = useStore();
  const adding = !log.editing;
  return (
    <MeasurementEditor title={t("weight")} log={log} valueFirst>
      <Field
        label={`${t("weight")} (${log.unit})`}
        value={log.inputs.weight ?? ""}
        onChange={(value) => log.setInputs((previous) => ({ ...previous, weight: value }))}
        numeric
        autoFocus={adding}
        selectTextOnFocus={adding}
        disabled={log.imported}
      />
    </MeasurementEditor>
  );
}
