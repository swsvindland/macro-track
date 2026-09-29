import { Field } from "@/vector";
import { useStore } from "@/lib/store";
import { MeasurementEditor } from "./measurement-editor";
import type { MeasurementLogState } from "./use-measurement-log";

export function WeightForm({ log }: { log: MeasurementLogState }) {
  const { t } = useStore();
  const adding = !log.editing;
  return (
    <MeasurementEditor title={t(adding ? "logWeight" : "editWeight")} log={log} valueFirst>
      <Field
        label={t("weight")}
        unit={log.unit}
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
