import { useRef, useState } from "react";
import { Alert, View } from "react-native";
import {
  Button,
  Callout,
  ErrorText,
  Field,
  Heading,
  Label,
  Meta,
  Note,
  Panel,
  useKitFormat,
} from "@/vector";
import {
  exportBackup,
  importBackup,
  recoveryBackupUri,
  restoreWithRecovery,
  shareBackupFile,
} from "@/lib/backup-files";
import type { Backup } from "@/lib/backup-data";
import { useNutrition, useNutritionQuery } from "@/lib/nutrition-store";
import { useStore } from "@/lib/store";
import type { Message } from "@/lib/translations";

type Mode = "create" | "restore";

export function BackupPanel() {
  const { refresh, t } = useStore();
  const format = useKitFormat();
  const { refresh: refreshNutrition } = useNutrition();
  // Null until Create or Restore is chosen; each opens its own password step.
  const [mode, setMode] = useState<Mode | null>(null);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [preview, setPreview] = useState<Backup | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const recovery = useNutritionQuery(recoveryBackupUri);
  const locked = useRef(false);
  async function run(work: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("backupFailed"));
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  const count = (n: number, one: Message, other: Message) =>
    t(format.plural(n) === "one" ? one : other, { count: format.number(n) });
  const created = preview ? new Date(preview.createdAt) : null;
  function choose(next: Mode | null) {
    setMode(next);
    setPreview(null);
    setError("");
    if (next) setMessage("");
    setPassword("");
    setConfirmation("");
  }
  return (
    <View className="gap-2">
      <Label accessibilityRole="header">{t("backupAndRestore")}</Label>
      <Panel>
        <Panel.Body>
          {!mode && (
            <View className="flex-row flex-wrap gap-2">
              <Button variant="secondary" onPress={() => choose("create")}>
                {t("createBackup")}
              </Button>
              <Button variant="secondary" onPress={() => choose("restore")}>
                {t("restoreBackup")}
              </Button>
            </View>
          )}
          {mode && !preview && (
            <>
              <Field
                label={t("backupPassword")}
                value={password}
                onChange={setPassword}
                secure
                disabled={busy}
              />
              {mode === "create" && (
                <Field
                  label={t("confirmPassword")}
                  value={confirmation}
                  onChange={setConfirmation}
                  secure
                  disabled={busy}
                />
              )}
              <Note>{t("backupPasswordHint")}</Note>
              <Button
                loading={busy}
                loadingLabel={t("working")}
                onPress={() =>
                  void run(async () => {
                    if (password.length < 10 || password.length > 256)
                      throw new Error(t("backupPasswordLength"));
                    if (mode === "create") {
                      if (password !== confirmation) throw new Error(t("backupPasswordsDiffer"));
                      await exportBackup(password);
                      choose(null);
                      setMessage(t("backupSavedNote"));
                    } else {
                      const selected = await importBackup(password);
                      setPreview(selected);
                    }
                  })
                }
              >
                {t(mode === "create" ? "saveEncryptedBackup" : "chooseBackupFile")}
              </Button>
              <Button variant="ghost" disabled={busy} onPress={() => choose(null)}>
                {t("cancel")}
              </Button>
            </>
          )}
          {preview && created && (
            <View className="gap-3">
              <Heading level={4}>
                {t("backupFrom", { date: format.date(created), time: format.time(created) })}
              </Heading>
              <Meta
                tone="default"
                items={[
                  count(preview.data.entries.length, "foodEntryCountOne", "foodEntryCount"),
                  count(preview.data.weights.length, "weightCountOne", "weightCount"),
                  count(preview.data.recipes.length, "recipeCountOne", "recipeCount"),
                  count(preview.data.savedMeals.length, "savedMealCountOne", "savedMealCount"),
                ]}
              />
              <Note>{t("restoreReplacesNote")}</Note>
              <Button
                variant="destructive"
                loading={busy}
                loadingLabel={t("restoring")}
                onPress={() =>
                  // vector: irreversible
                  Alert.alert(t("replaceRecordsQuestion"), t("replaceRecordsBody"), [
                    { text: t("cancel"), style: "cancel" },
                    {
                      text: t("restoreBackup"),
                      style: "destructive",
                      onPress: () =>
                        void run(async () => {
                          await restoreWithRecovery(preview, password);
                          refresh();
                          refreshNutrition();
                          choose(null);
                          setMessage(t("restoredNote"));
                        }),
                    },
                  ])
                }
              >
                {t("replaceWithBackup")}
              </Button>
              <Button variant="ghost" disabled={busy} onPress={() => choose(null)}>
                {t("cancelRestore")}
              </Button>
            </View>
          )}
          {recovery && (
            <Button
              variant="secondary"
              disabled={busy}
              onPress={() =>
                void run(async () => {
                  await shareBackupFile(recovery);
                })
              }
            >
              {t("exportRecoveryBackup")}
            </Button>
          )}
          {!!message && <Callout tone="success">{message}</Callout>}
          <ErrorText message={error} />
        </Panel.Body>
      </Panel>
    </View>
  );
}
