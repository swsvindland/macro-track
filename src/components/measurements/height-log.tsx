import { Button, Panel, Screen, Value } from "@/vector";
import { useStore } from "@/lib/store";
import { useMeasurementLog } from "./use-measurement-log";
import { HeightForm } from "./height-form";
import { MeasurementHistory } from "./measurement-history";

export function HeightLog() {
  const { t, date } = useStore();
  const log = useMeasurementLog("height");
  const { rows, readout, launch } = log;
  return (
    <>
      <Screen
        title={t("height")}
        subtitle={t("cadenceBetween", { from: t("monthly"), to: t("yearly") })}
      >
        {rows[0] && (
          <Panel>
            <Panel.Header eyebrow={t("latest")} meta={date(rows[0].measuredAt)} />
            <Panel.Body>
              <Value size="l" {...readout("height", rows[0].values.height)} />
            </Panel.Body>
          </Panel>
        )}
        <Button icon="add" onPress={() => launch(null)}>
          {t("addHeight")}
        </Button>
        <MeasurementHistory log={log} />
      </Screen>
      <HeightForm log={log} />
    </>
  );
}
