import { useRef, useState } from "react";
import { Alert } from "react-native";
import { SystemButton, SystemPanel, SystemText as Text } from "@/components/system";
import { ErrorText } from "@/components/ui";
import { shareCsv, eraseLocalData } from "@/lib/data-files";
import { useStore } from "@/lib/store";
import { useNutrition } from "@/lib/nutrition-store";
export function DataPanel() {
  const { refresh } = useStore();
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
      setError(e instanceof Error ? e.message : "Could not complete this action.");
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  return (
    <SystemPanel>
      <SystemPanel.Body className="gap-3">
        <Text className="text-xl font-semibold">Your data</Text>
        <SystemButton
          variant="secondary"
          isDisabled={busy}
          onPress={() => void run(() => shareCsv("diary"))}
        >
          Export food diary CSV
        </SystemButton>
        <SystemButton
          variant="secondary"
          isDisabled={busy}
          onPress={() => void run(() => shareCsv("weight"))}
        >
          Export weight CSV
        </SystemButton>
        <SystemButton
          variant="danger-soft"
          isDisabled={busy}
          onPress={() =>
            Alert.alert(
              "Erase all local personal data?",
              "This deletes your diary, weights, foods, recipes, plans, settings and app-held recovery backups. It cannot be undone. Export a backup first if you want to keep them. Files already shared and Apple Health or Health Connect records are not deleted.",
              [
                { text: "Cancel", style: "cancel" },
                {
                  text: "Erase local data",
                  style: "destructive",
                  onPress: () =>
                    void run(async () => {
                      await eraseLocalData();
                      refresh();
                      refreshNutrition();
                      setMessage("Local personal data erased. Health sync is off.");
                    }),
                },
              ]
            )
          }
        >
          Erase local personal data
        </SystemButton>
        {!!message && <Text accessibilityLiveRegion="polite">{message}</Text>}
        <ErrorText message={error} />
      </SystemPanel.Body>
    </SystemPanel>
  );
}
