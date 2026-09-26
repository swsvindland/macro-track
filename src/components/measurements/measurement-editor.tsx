import type { ReactNode } from "react";
import { SystemButton, SystemText as Text } from "@/components/system";
import { DateInput, Editor, ErrorText } from "@/components/ui";
import { useStore } from "@/lib/store";
import type { MeasurementLogState } from "./use-measurement-log";

export function MeasurementEditor({
  title,
  log,
  children,
  valueFirst = false,
}: {
  title: string;
  log: MeasurementLogState;
  children: ReactNode;
  /** Puts the value above the date, for entries that are almost always logged today. */
  valueFirst?: boolean;
}) {
  const { t } = useStore();
  const { editing, open, setOpen, busy, imported, day, setDay, error, save, remove, exclude } = log;
  const date = <DateInput label={t("date")} value={day} onChange={setDay} disabled={imported} />;
  return (
    <Editor
      title={`${t(editing ? "edit" : "add")} · ${title}`}
      open={open}
      close={() => setOpen(false)}
      busy={busy}
      footer={
        imported ? undefined : (
          <SystemButton isDisabled={busy} onPress={save}>
            {t("save")}
          </SystemButton>
        )
      }
    >
      {imported && <Text className="text-muted">{t("syncHelp")}</Text>}
      {!valueFirst && date}
      {children}
      {valueFirst && date}
      <ErrorText message={error} />
      {editing && exclude && (
        <SystemButton
          variant="secondary"
          isDisabled={busy}
          accessibilityState={{ checked: !!editing.excluded }}
          onPress={() => exclude(editing, !editing.excluded)}
        >
          {editing.excluded ? "Include in trend" : "Ignore in trend"}
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
