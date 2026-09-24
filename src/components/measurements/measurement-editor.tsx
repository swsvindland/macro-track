import type { ReactNode } from "react";
import { SystemButton, SystemText as Text } from "@/components/system";
import { DateInput, Editor, ErrorText } from "@/components/ui";
import { useStore } from "@/lib/store";
import type { MeasurementLogState } from "./use-measurement-log";

export function MeasurementEditor({
  title,
  log,
  children,
}: {
  title: string;
  log: MeasurementLogState;
  children: ReactNode;
}) {
  const { t } = useStore();
  const { editing, open, setOpen, busy, imported, day, setDay, error, save, remove } = log;
  return (
    <Editor
      title={`${t(editing ? "edit" : "add")} · ${title}`}
      open={open}
      close={() => setOpen(false)}
      busy={busy}
    >
      {imported && <Text className="text-muted">{t("syncHelp")}</Text>}
      <DateInput label={t("date")} value={day} onChange={setDay} disabled={imported} />
      {children}
      <ErrorText message={error} />
      {!imported && (
        <SystemButton isDisabled={busy} onPress={save}>
          {t("save")}
        </SystemButton>
      )}
      {editing && (
        <SystemButton variant="danger-soft" isDisabled={busy} onPress={remove}>
          {t("delete")}
        </SystemButton>
      )}
    </Editor>
  );
}
