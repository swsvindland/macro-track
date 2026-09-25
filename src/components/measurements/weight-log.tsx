import { IntakeSummary } from "@/components/nutrition/intake-summary";
import { SystemButton } from "@/components/system";
import { Screen } from "@/components/ui";
import { Dashboard } from "@/components/dashboard";
import { useStore } from "@/lib/store";
import { useMeasurementLog } from "./use-measurement-log";
import { WeightForm } from "./weight-form";
import { MeasurementHistory } from "./measurement-history";

export function WeightLog() {
  const { t } = useStore();
  const log = useMeasurementLog("weight");
  const { launch } = log;
  return (
    <>
      <Screen title="Progress">
        <Dashboard weightOnly />
        <SystemButton icon="scale-outline" onPress={() => launch(null)}>
          {`${t("add")} · ${t("weight")}`}
        </SystemButton>
        <IntakeSummary />
        <MeasurementHistory log={log} />
      </Screen>
      <WeightForm log={log} />
    </>
  );
}
