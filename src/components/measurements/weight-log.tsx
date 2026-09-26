import { Platform } from "react-native";
import { router } from "expo-router";
import { SystemButton, SystemIconButton } from "@/components/system";
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
  const health = Platform.OS === "ios" ? "Apple Health" : "Health Connect";
  return (
    <>
      <DetailScreen
        title="Weight history"
        action={
          <SystemIconButton
            icon="add"
            accessibilityLabel={`${t("add")} · ${t("weight")}`}
            onPress={() => launch(null)}
          />
        }
      >
        <MeasurementHistory log={log} />
        <SystemButton
          variant="ghost"
          className="self-start px-0"
          labelClassName="text-accent-soft-foreground"
          // Back to the tabs underneath, rather than a second copy of them on top.
          onPress={() => router.dismissTo("/(tabs)/settings")}
        >
          {healthSyncEnabled
            ? `${health} · ${lastSync ? `${t("lastSync")} ${date(lastSync)}` : "On"}`
            : `Sync weights with ${health}`}
        </SystemButton>
      </DetailScreen>
      <WeightForm log={log} />
    </>
  );
}
