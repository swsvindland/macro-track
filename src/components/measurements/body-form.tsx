import { Field } from "@/components/ui";
import { useStore } from "@/lib/store";
import { sites } from "@/lib/metrics";
import { MeasurementEditor } from "./measurement-editor";
import type { MeasurementLogState } from "./use-measurement-log";

export function BodyForm({ log }: { log: MeasurementLogState }) {
  const { t } = useStore();
  return (
    <MeasurementEditor title={t("body")} log={log}>
      {sites.map((site) => (
        <Field
          key={site}
          label={`${t(site)} (${log.unit}) · ${t("optional")}`}
          value={log.inputs[site] ?? ""}
          onChange={(value) => log.setInputs((previous) => ({ ...previous, [site]: value }))}
          numeric
          disabled={log.imported}
        />
      ))}
      <Field
        label={`${t("manualFat")} · ${t("optional")}`}
        value={log.inputs.bodyFat ?? ""}
        onChange={(value) => log.setInputs((previous) => ({ ...previous, bodyFat: value }))}
        numeric
        disabled={log.imported}
      />
    </MeasurementEditor>
  );
}
