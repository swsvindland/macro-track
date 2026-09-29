import { DataPanel } from "@/components/nutrition/data-panel";
import { BackupPanel } from "@/components/nutrition/backup-panel";
import { useState, type ReactNode } from "react";
import { Platform, View } from "react-native";
import { router } from "expo-router";
import {
  Button,
  Callout,
  Choices,
  ErrorText,
  Label,
  LinkButton,
  ListRow,
  Note,
  Panel,
  Screen,
  Select,
  useKitFormat,
  type IntlUnit,
} from "@/vector";
import type { Units } from "@/lib/metrics";
import { useStore } from "@/lib/store";
import { languages, type LanguagePreference, type Message } from "@/lib/translations";
import { enableHealthSync, disableHealthSync } from "@/lib/health-schedule";

/** Health failures with their own explanation; anything else is reported as a failed sync. */
const healthErrors = ["healthUnavailable", "healthWeightDenied", "syncing"] as const;
/** The weight and length units each system shows, as the locale writes their symbols. */
const unitSymbols: Record<Units, [IntlUnit, IntlUnit]> = {
  metric: ["kilogram", "centimeter"],
  imperial: ["pound", "inch"],
  stone: ["stone", "inch"],
};

/**
 * The SettingsSection anatomy (an eyebrow that is a rotor heading, then the content) for groups a
 * row panel does not fit: a control that draws its own edge (Choices, Select).
 */
function Section({ eyebrow, children }: { eyebrow: string; children: ReactNode }) {
  return (
    <View className="gap-2">
      <Label accessibilityRole="header">{eyebrow}</Label>
      {children}
    </View>
  );
}

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
  const format = useKitFormat();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Message | "">("");
  const [message, setMessage] = useState<Message | "">("");
  const shownError = error || healthSyncError;
  const health = t(Platform.OS === "ios" ? "appleHealth" : "healthConnect");
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
        (error instanceof Error && healthErrors.find((key) => key === error.message)) ||
          "syncFailed"
      );
    } finally {
      refresh();
      setBusy(false);
    }
  }
  return (
    <Screen title={t("settings")} width="form">
      <Section eyebrow={t("appearance")}>
        <Choices
          values={["system", "light", "dark"] as const}
          value={theme}
          onChange={(value) => preference("theme", value)}
          label={t}
          accessibilityLabel={t("appearance")}
        />
      </Section>
      <Section eyebrow={t("units")}>
        <Select
          title={t("units")}
          values={["metric", "imperial", "stone"] as const}
          value={units}
          onChange={(value) => preference("units", value)}
          // The same unit symbols the readouts use (公斤 in zh).
          label={(value) =>
            t("unitsOption", {
              name: t(value),
              weight: format.unitParts(2, unitSymbols[value][0]).unit,
              length: format.unitParts(2, unitSymbols[value][1]).unit,
            })
          }
        />
      </Section>
      <Section eyebrow={t("language")}>
        <Select
          title={t("language")}
          values={["system", ...Object.keys(languages)] as LanguagePreference[]}
          value={languagePreference}
          onChange={(value) => preference("language", value)}
          label={(value) => (value === "system" ? t("system") : languages[value])}
        />
      </Section>
      <View className="gap-3">
        <Section eyebrow={health}>
          {/* Held while a sync or permission request runs. */}
          <Panel inset="none">
            <ListRow
              title={t(busy ? "syncing" : "sync")}
              description={lastSync ? t("lastSyncOn", { date: date(lastSync) }) : undefined}
              trailing="toggle"
              toggleValue={healthSyncEnabled}
              onToggle={(enabled) => void toggleSync(enabled)}
              disabled={busy}
            />
          </Panel>
        </Section>
        {healthAccessOutdated && !busy && (
          <View className="items-start gap-2">
            <Note>{t("nutritionAccessPrompt", { provider: health })}</Note>
            <Button variant="secondary" onPress={() => void toggleSync(true)}>
              {t("allowNutrition")}
            </Button>
          </View>
        )}
        {message ? <Callout tone="success">{t(message)}</Callout> : null}
        <ErrorText message={shownError ? t(shownError) : ""} />
        <LinkButton icon="forward" onPress={() => router.push("/health-privacy")}>
          {t("whatSyncs")}
        </LinkButton>
      </View>
      <Section eyebrow={t("foodDiary")}>
        <Choices
          values={["timeline", "meals"] as const}
          value={diaryLayout}
          onChange={(value) => preference("diaryLayout", value)}
          label={(value) => t(value === "timeline" ? "timeBasedTimeline" : "classicMeals")}
          accessibilityLabel={t("diaryLayout")}
        />
        <Choices
          values={["hidden", "shown"] as const}
          value={hideEmptyHours ? "hidden" : "shown"}
          onChange={(value) => preference("hideEmptyHours", String(value === "hidden"))}
          label={(value) => t(value === "hidden" ? "hideEmptyHours" : "showAllHours")}
          accessibilityLabel={t("emptyHours")}
        />
        <Panel inset="none">
          <ListRow
            title={t("countLoggedDays")}
            description={t("countLoggedDaysHelp", {
              time: format.time(new Date(2024, 0, 1, 4)),
              count: format.number(3),
              percent: format.percent(0.7),
            })}
            trailing="toggle"
            toggleValue={countLoggedDays}
            onToggle={(value) => preference("countLoggedDays", String(value))}
          />
        </Panel>
      </Section>
      <BackupPanel />
      <DataPanel />
    </Screen>
  );
}
