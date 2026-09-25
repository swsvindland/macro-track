import { useRef, useState } from "react";
import { Alert, View } from "react-native";
import { SystemButton, SystemPanel, SystemText as Text } from "@/components/system";
import { Choices, ErrorText, Field } from "@/components/ui";
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

export function BackupPanel() {
  const { refresh } = useStore();
  const { refresh: refreshNutrition } = useNutrition();
  const [mode, setMode] = useState<"Create backup" | "Restore backup">("Create backup");
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
      setError(e instanceof Error ? e.message : "The backup operation failed.");
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  return (
    <SystemPanel>
      <SystemPanel.Body className="gap-4">
        <Text className="text-xl font-semibold">Backup & restore</Text>
        {!busy && (
          <Choices
            values={["Create backup", "Restore backup"] as const}
            value={mode}
            label={(value) => value}
            onChange={(value) => {
              setMode(value);
              setPreview(null);
              setError("");
              setMessage("");
              setPassword("");
              setConfirmation("");
            }}
          />
        )}
        {!preview && (
          <>
            <Field
              label="Backup password"
              value={password}
              onChange={setPassword}
              secure
              disabled={busy}
            />
            {mode === "Create backup" && (
              <Field
                label="Confirm password"
                value={confirmation}
                onChange={setConfirmation}
                secure
                disabled={busy}
              />
            )}
            <Text className="text-sm text-muted">
              At least 10 characters. It can’t be recovered.
            </Text>
            <SystemButton
              isDisabled={busy}
              onPress={() =>
                void run(async () => {
                  if (password.length < 10 || password.length > 256)
                    throw new Error("Use a password between 10 and 256 characters.");
                  if (mode === "Create backup") {
                    if (password !== confirmation) throw new Error("The passwords don’t match.");
                    await exportBackup(password);
                    setPassword("");
                    setConfirmation("");
                    setMessage(
                      "The share sheet closed. Your backup is saved only if you chose a destination."
                    );
                  } else {
                    const selected = await importBackup(password);
                    setPreview(selected);
                  }
                })
              }
            >
              {busy
                ? "Working…"
                : mode === "Create backup"
                  ? "Save encrypted backup"
                  : "Choose backup file"}
            </SystemButton>
          </>
        )}
        {preview && (
          <View className="gap-3">
            <Text className="font-semibold">
              Backup from {new Date(preview.createdAt).toLocaleString()}
            </Text>
            <Text>
              {preview.data.entries.length} food entries · {preview.data.weights.length} weights
            </Text>
            <Text>
              {preview.data.recipes.length} recipes · {preview.data.savedMeals.length} saved meals
            </Text>
            <Text className="text-sm text-muted">
              Replaces your current food and weight records and turns off Health sync. A recovery
              copy is saved first.
            </Text>
            <SystemButton
              variant="danger-soft"
              isDisabled={busy}
              onPress={() =>
                Alert.alert(
                  "Replace local records?",
                  "Your current nutrition records and weights will be replaced by this backup. A recovery copy will be saved first.",
                  [
                    { text: "Cancel", style: "cancel" },
                    {
                      text: "Restore backup",
                      style: "destructive",
                      onPress: () =>
                        void run(async () => {
                          await restoreWithRecovery(preview, password);
                          refresh();
                          refreshNutrition();
                          setPreview(null);
                          setPassword("");
                          setMessage(
                            "Restore complete. Your previous records are available in the recovery backup below, with the same password."
                          );
                        }),
                    },
                  ]
                )
              }
            >
              {busy ? "Restoring…" : "Replace with this backup"}
            </SystemButton>
            <SystemButton
              variant="ghost"
              isDisabled={busy}
              onPress={() => {
                setPreview(null);
                setPassword("");
              }}
            >
              Cancel restore
            </SystemButton>
          </View>
        )}
        {recovery && (
          <SystemButton
            variant="secondary"
            isDisabled={busy}
            onPress={() =>
              void run(async () => {
                await shareBackupFile(recovery);
              })
            }
          >
            Export previous-data recovery backup
          </SystemButton>
        )}
        {!!message && (
          <Text className="text-sm text-success" accessibilityLiveRegion="polite">
            {message}
          </Text>
        )}
        <ErrorText message={error} />
      </SystemPanel.Body>
    </SystemPanel>
  );
}
