import { Field } from "@/vector";
import { useStore } from "@/lib/store";
import { sites } from "@/lib/metrics";
import { MeasurementEditor } from "./measurement-editor";
import type { MeasurementLogState } from "./use-measurement-log";

export function BodyForm({ log }: { log: MeasurementLogState }) {
  const { t } = useStore();
  return (
    <MeasurementEditor title={t(log.editing ? "editMeasurements" : "addMeasurements")} log={log}>
      {sites.map((site) => (
        <Field
          key={site}
          label={t("optionalField", { field: t(site) })}
          unit={log.unit}
          value={log.inputs[site] ?? ""}
          onChange={(value) => log.setInputs((previous) => ({ ...previous, [site]: value }))}
          numeric
          disabled={log.imported}
        />
      ))}
      <Field
        label={t("optionalField", { field: t("manualFat") })}
        value={log.inputs.bodyFat ?? ""}
        onChange={(value) => log.setInputs((previous) => ({ ...previous, bodyFat: value }))}
        numeric
        disabled={log.imported}
      />
    </MeasurementEditor>
  );
}
