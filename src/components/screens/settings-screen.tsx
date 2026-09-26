import { DataPanel } from "@/components/nutrition/data-panel";
import { BackupPanel } from "@/components/nutrition/backup-panel";
import { useState } from "react";
import { Switch } from "heroui-native";
import { Platform, View } from "react-native";
import { router } from "expo-router";
import { SystemButton, SystemLabel, SystemPanel, SystemText as Text } from "@/components/system";
import { SettingsSelect, ErrorText, Screen } from "@/components/ui";
import { useStore } from "@/lib/store";
import { languages, type LanguagePreference } from "@/lib/translations";
import { enableHealthSync, disableHealthSync } from "@/lib/health-schedule";

export function SettingsScreen() {
  const {
    units,
    diaryLayout,
    hideEmptyHours,
    countLoggedDays,
    languagePreference,
    theme,
    healthSyncEnabled,
    healthSyncError,
    healthAccessOutdated,
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
        error instanceof Error &&
          ["healthUnavailable", "healthWeightDenied", "syncing"].includes(error.message)
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
      <SystemPanel className="p-4">
        <SystemPanel.Body className="gap-4">
          {(
            [
              [
                t("theme"),
                <SettingsSelect
                  key="theme"
                  title={t("theme")}
                  values={["dark", "light", "system"] as const}
                  value={theme}
                  onChange={(value) => preference("theme", value)}
                  label={t}
                />,
              ],
              [
                t("units"),
                <SettingsSelect
                  key="units"
                  title={t("units")}
                  values={["metric", "imperial", "stone"] as const}
                  value={units}
                  onChange={(value) => preference("units", value)}
                  label={(value) =>
                    `${t(value)} · ${value === "metric" ? "kg / cm" : value === "imperial" ? "lb / in" : "st / in"}`
                  }
                />,
              ],
              [
                t("language"),
                <SettingsSelect
                  key="language"
                  title={t("language")}
                  values={["system", ...Object.keys(languages)] as LanguagePreference[]}
                  value={languagePreference}
                  onChange={(value) => preference("language", value)}
                  label={(value) => (value === "system" ? t("system") : languages[value])}
                />,
              ],
            ] as const
          ).map(([title, control]) => (
            <View key={title} className="gap-2">
              <SystemLabel>{title}</SystemLabel>
              {control}
            </View>
          ))}
        </SystemPanel.Body>
      </SystemPanel>
      <SystemPanel className="p-4">
        <SystemPanel.Body className="gap-2">
          <View className="flex-row items-center justify-between gap-4">
            <View className="flex-1 gap-0.5">
              <Text className="font-semibold">
                {Platform.OS === "ios" ? "Apple Health" : "Health Connect"}
              </Text>
              <Text className="text-sm text-muted">
                {busy ? t("syncing") : lastSync ? `${t("lastSync")}: ${date(lastSync)}` : t("sync")}
              </Text>
            </View>
            <Switch
              accessibilityLabel={t("sync")}
              isSelected={healthSyncEnabled}
              isDisabled={busy}
              onSelectedChange={toggleSync}
            />
          </View>
          {healthAccessOutdated && !busy && (
            <View className="gap-2">
              <Text className="text-sm">
                Food you log can now be written to{" "}
                {Platform.OS === "ios" ? "Apple Health" : "Health Connect"} as nutrition. Allow it
                to start.
              </Text>
              <SystemButton
                variant="secondary"
                className="self-start"
                onPress={() => void toggleSync(true)}
              >
                Allow nutrition
              </SystemButton>
            </View>
          )}
          {message && (
            <Text accessibilityLiveRegion="polite" className="text-sm text-success">
              {t(message)}
            </Text>
          )}
          <SystemButton
            variant="ghost"
            className="self-start px-0"
            labelClassName="text-accent-soft-foreground"
            onPress={() => router.push("/health-privacy")}
          >
            What syncs
          </SystemButton>
        </SystemPanel.Body>
      </SystemPanel>
      <SystemPanel className="p-4">
        <SystemPanel.Body className="gap-2">
          <SystemLabel>Food diary</SystemLabel>
          <SettingsSelect
            title="Diary layout"
            values={["timeline", "meals"] as const}
            value={diaryLayout}
            onChange={(value) => preference("diaryLayout", value)}
            label={(value) => (value === "timeline" ? "Time-based timeline" : "Classic meals")}
          />
          <SettingsSelect
            title="Empty hours"
            values={["hidden", "shown"] as const}
            value={hideEmptyHours ? "hidden" : "shown"}
            onChange={(value) => preference("hideEmptyHours", String(value === "hidden"))}
            label={(value) => (value === "hidden" ? "Hide empty hours" : "Show all 24 hours")}
          />
          <View className="flex-row items-center justify-between gap-4 pt-2">
            <View className="flex-1 gap-0.5">
              <Text className="font-semibold">Count logged days as complete</Text>
              <Text className="text-sm text-muted">
                After 04:00, yesterday counts as complete without asking when 3 or more foods logged
                as you ate reach 70% of its target.
              </Text>
            </View>
            <Switch
              accessibilityLabel="Count logged days as complete"
              isSelected={countLoggedDays}
              onSelectedChange={(value) => preference("countLoggedDays", String(value))}
            />
          </View>
        </SystemPanel.Body>
      </SystemPanel>
      <BackupPanel />
      <DataPanel />
      <ErrorText message={error || healthSyncError ? t(error || healthSyncError) : ""} />
    </Screen>
  );
}
