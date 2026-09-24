import { router } from "expo-router";
import { SystemButton, SystemText as Text } from "@/components/system";
import { Screen } from "@/components/ui";
import { useStore } from "@/lib/store";
export function HealthPrivacyScreen() {
  const { t } = useStore();
  return (
    <Screen title={t("sync")}>
      <Text className="text-foreground">{t("healthPrivacy")}</Text>
      <Text className="text-muted">{t("syncHelp")}</Text>
      <Text className="text-muted">{t("localPhotos")}</Text>
      <SystemButton onPress={() => router.replace("/(tabs)/settings")}>
        {t("settings")}
      </SystemButton>
    </Screen>
  );
}
