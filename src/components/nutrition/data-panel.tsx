import { useRef, useState } from "react";
import { Alert, View } from "react-native";
import { Button, Callout, ErrorText, ListRow, SettingsSection } from "@/vector";
import { shareCsv, eraseLocalData } from "@/lib/data-files";
import { useStore } from "@/lib/store";
import { useNutrition } from "@/lib/nutrition-store";
import { captureBeforeErase, onLocalDataErased } from "@/vault/engine/erase";
import { vaultSupported } from "@/vault/native";
export function DataPanel() {
  const { refresh, t } = useStore();
  const { refresh: refreshNutrition } = useNutrition();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const locked = useRef(false);
  async function run(action: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("couldNotComplete"));
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  return (
    <View className="gap-3">
      {/* Held while an export runs. */}
      <SettingsSection eyebrow={t("yourData")}>
        <ListRow
          icon="share"
          title={t("exportDiaryCsv")}
          trailing="none"
          disabled={busy}
          onPress={() => void run(() => shareCsv("diary"))}
        />
        <ListRow
          icon="share"
          title={t("exportWeightCsv")}
          trailing="none"
          disabled={busy}
          onPress={() => void run(() => shareCsv("weight"))}
        />
        <ListRow
          icon="share"
          title={t("exportTargetsCsv")}
          trailing="none"
          disabled={busy}
          onPress={() => void run(() => shareCsv("targets"))}
        />
      </SettingsSection>
      <Button
        variant="destructive"
        icon="delete"
        disabled={busy}
        className="self-start"
        onPress={() =>
          // vector: irreversible
          Alert.alert(t("eraseQuestion"), t("eraseBody"), [
            { text: t("cancel"), style: "cancel" },
            {
              text: t("eraseLocalData"),
              style: "destructive",
              onPress: () =>
                void run(async () => {
                  // The vault keeps the Health installations this data was written under, so
                  // turning sync back on does not import it again; it also drops its restore
                  // copies and starts a new library.
                  const keep = vaultSupported ? await captureBeforeErase() : null;
                  await eraseLocalData();
                  if (keep) await onLocalDataErased(keep);
                  refresh();
                  refreshNutrition();
                  setMessage(t("erasedNote"));
                }),
            },
          ])
        }
      >
        {t("eraseAllData")}
      </Button>
      {!!message && <Callout tone="success">{message}</Callout>}
      <ErrorText message={error} />
    </View>
  );
}
