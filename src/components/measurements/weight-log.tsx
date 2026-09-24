import { SystemButton } from "@/components/system";
import { Screen } from "@/components/ui";
import { useStore } from "@/lib/store";
import { Dashboard } from "@/components/dashboard";
import { useMeasurementLog } from "./use-measurement-log";
import { WeightForm } from "./weight-form";
import { MeasurementHistory } from "./measurement-history";

export function WeightLog() {
  const { t } = useStore();
  const log = useMeasurementLog("weight");
  const { launch } = log;
  return (
    <>
      <Screen title={t("home")} subtitle={`${t("cadence")}: ${t("daily")}`}>
        <Dashboard />

        <SystemButton onPress={() => launch(null)}>
          {t("add")} · {t("weight")}
        </SystemButton>
        <MeasurementHistory log={log} />
      </Screen>
      <WeightForm log={log} />
    </>
  );
}
