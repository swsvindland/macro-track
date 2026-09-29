import { Platform } from "react-native";
import { router } from "expo-router";
import { LinkButton } from "@/vector";
import { DetailScreen } from "@/components/progress/detail-screen";
import { useStore } from "@/lib/store";
import { useMeasurementLog } from "./use-measurement-log";
import { WeightForm } from "./weight-form";
import { MeasurementHistory } from "./measurement-history";

/** Every weigh-in, to add, edit, ignore or delete; Health sync stays one tap away. */
export function WeightLog() {
  const { t, date, healthSyncEnabled, lastSync } = useStore();
  const log = useMeasurementLog("weight");
  const { launch } = log;
  const provider = t(Platform.OS === "ios" ? "appleHealth" : "healthConnect");
  return (
    <>
      <DetailScreen
        title={t("weightHistory")}
        action={{
          icon: "add",
          accessibilityLabel: t("logWeight"),
          onPress: () => launch(null),
        }}
      >
        <MeasurementHistory log={log} />
        <LinkButton
          icon="forward"
          // Back to the tabs underneath, rather than a second copy of them on top.
          onPress={() => router.dismissTo("/(tabs)/settings")}
        >
          {healthSyncEnabled
            ? lastSync
              ? t("healthLastSync", { provider, date: date(lastSync) })
              : t("healthOn", { provider })
            : t("syncWeightsWith", { provider })}
        </LinkButton>
      </DetailScreen>
      <WeightForm log={log} />
    </>
  );
}
