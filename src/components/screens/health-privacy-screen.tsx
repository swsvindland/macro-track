import { DetailScreen, Note, Text } from "@/vector";
import { useStore } from "@/lib/store";
export function HealthPrivacyScreen() {
  const { t } = useStore();
  return (
    <DetailScreen title={t("sync")}>
      <Text>{t("healthPrivacy")}</Text>
      <Note>{t("syncHelp")}</Note>
      <Note>{t("localPhotos")}</Note>
      <Note>{t("syncSchedule")}</Note>
    </DetailScreen>
  );
}
