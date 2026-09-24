import { SystemButton, SystemText as Text } from "@/components/system";
import { Screen } from "@/components/ui";
import { useStore } from "@/lib/store";
import { useMeasurementLog } from "./use-measurement-log";
import { BodyForm } from "./body-form";
import { MeasurementHistory } from "./measurement-history";

export function BodyLog() {
  const { t } = useStore();
  const log = useMeasurementLog("body");
  const { launch } = log;
  return (
    <>
      <Screen title={t("body")} subtitle={`${t("cadence")}: ${t("weekly")} – ${t("monthly")}`}>
        <Text className="text-muted">{t("bodyHelp")}</Text>
        <SystemButton onPress={() => launch(null)}>
          {t("add")} · {t("body")}
        </SystemButton>
        <MeasurementHistory log={log} />
      </Screen>
      <BodyForm log={log} />
    </>
  );
}
