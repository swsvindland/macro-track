import { useState } from "react";
import { RadioGroup, Switch } from "heroui-native";
import { Platform, View } from "react-native";
import { SystemPanel, SystemText as Text } from "@/components/system";
import { SettingsSelect, ErrorText, Screen } from "@/components/ui";
import { useStore } from "@/lib/store";
import { languages, type LanguagePreference } from "@/lib/translations";
import { enableHealthSync, disableHealthSync } from "@/lib/health-schedule";

export function SettingsScreen() {
  const {
    units,
    formula,
    languagePreference,
    theme,
    healthSyncEnabled,
    healthSyncError,
    lastSync,
    setPreference,
    refresh,
    t,
    date,
  } = useStore();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  function preference(key: string, value: string) {
    try {
      setPreference(key, value);
      setError("");
    } catch {
      setError("error");
    }
  }
  async function toggleSync(enabled: boolean) {
    if (busy) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      if (enabled) {
        await enableHealthSync();
        setMessage("syncDone");
      } else {
        await disableHealthSync();
      }
    } catch (error) {
      setError(
        error instanceof Error && ["healthUnavailable", "syncing"].includes(error.message)
          ? error.message
          : "syncFailed"
      );
    } finally {
      refresh();
      setBusy(false);
    }
  }
  return (
    <Screen title={t("settings")}>
      <SystemPanel>
        <SystemPanel.Body className="gap-3">
          <SystemPanel.Title>{t("theme")}</SystemPanel.Title>
          <SettingsSelect
            title={t("theme")}
            values={["dark", "light", "system"] as const}
            value={theme}
            onChange={(value) => preference("theme", value)}
            label={t}
          />
        </SystemPanel.Body>
      </SystemPanel>
      <SystemPanel>
        <SystemPanel.Body className="gap-3">
          <SystemPanel.Title>{t("units")}</SystemPanel.Title>
          <SettingsSelect
            title={t("units")}
            values={["metric", "imperial", "stone"] as const}
            value={units}
            onChange={(value) => preference("units", value)}
            label={(value) =>
              `${t(value)} · ${value === "metric" ? "kg / cm" : value === "imperial" ? "lb / in" : "st / in"}`
            }
          />
        </SystemPanel.Body>
      </SystemPanel>
      <SystemPanel>
        <SystemPanel.Body className="gap-3">
          <SystemPanel.Title>{t("language")}</SystemPanel.Title>
          <SettingsSelect
            title={t("language")}
            values={["system", ...Object.keys(languages)] as LanguagePreference[]}
            value={languagePreference}
            onChange={(value) => preference("language", value)}
            label={(value) => (value === "system" ? t("system") : languages[value])}
          />
        </SystemPanel.Body>
      </SystemPanel>
      <SystemPanel>
        <SystemPanel.Body className="gap-3">
          <SystemPanel.Title>{t("formula")}</SystemPanel.Title>
          <RadioGroup
            accessibilityLabel={t("formula")}
            value={formula}
            onValueChange={(value) => preference("formula", value)}
          >
            <RadioGroup.Item value="male">{t("male")}</RadioGroup.Item>
            <RadioGroup.Item value="female">{t("female")}</RadioGroup.Item>
          </RadioGroup>
          <Text className="text-sm text-muted">{t("bodyHelp")}</Text>
        </SystemPanel.Body>
      </SystemPanel>
      <SystemPanel>
        <SystemPanel.Body className="gap-3">
          <SystemPanel.Title>
            {Platform.OS === "ios" ? "Apple Health" : "Health Connect"}
          </SystemPanel.Title>
          <Text className="text-muted">{t("healthPrivacy")}</Text>
          <Text className="text-sm text-muted">{t("syncHelp")}</Text>
          {lastSync && (
            <Text className="text-sm text-muted">
              {t("lastSync")}: {date(lastSync)}
            </Text>
          )}
          <View className="flex-row items-center justify-between gap-4">
            <Text className="flex-1">{t(busy ? "syncing" : "sync")}</Text>
            <Switch
              accessibilityLabel={t("sync")}
              isSelected={healthSyncEnabled}
              isDisabled={busy}
              onSelectedChange={toggleSync}
            />
          </View>
          <Text className="text-sm text-muted">{t("syncSchedule")}</Text>
          {message && (
            <Text
              accessibilityLiveRegion="polite"
              className="border-l-2 border-success pl-3 text-success"
            >
              {t(message)}
            </Text>
          )}
        </SystemPanel.Body>
      </SystemPanel>
      <ErrorText message={error || healthSyncError ? t(error || healthSyncError) : ""} />
    </Screen>
  );
}
