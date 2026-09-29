import type { ReactNode } from "react";
import { Button, DateInput, ErrorText, Note } from "@/vector";
import { Editor } from "@/components/ui";
import { useStore } from "@/lib/store";
import type { MeasurementLogState } from "./use-measurement-log";

export function MeasurementEditor({
  title,
  log,
  children,
  valueFirst = false,
}: {
  /** Already says whether it adds or edits, e.g. "Edit weight". */
  title: string;
  log: MeasurementLogState;
  children: ReactNode;
  /** Puts the value above the date, for entries that are almost always logged today. */
  valueFirst?: boolean;
}) {
  const { t } = useStore();
  const {
    editing,
    open,
    setOpen,
    busy,
    dirty,
    imported,
    day,
    setDay,
    error,
    save,
    remove,
    exclude,
  } = log;
  const date = <DateInput label={t("date")} value={day} onChange={setDay} disabled={imported} />;
  return (
    <Editor
      title={title}
      open={open}
      close={() => setOpen(false)}
      busy={busy}
      dirty={dirty}
      primary={imported ? undefined : { label: t("save"), onPress: save, disabled: busy }}
    >
      {imported && <Note>{t("syncHelp")}</Note>}
      {!valueFirst && date}
      {children}
      {valueFirst && date}
      <ErrorText message={error} />
      {editing && exclude && (
        <Button
          variant="secondary"
          disabled={busy}
          accessibilityState={{ checked: !!editing.excluded }}
          onPress={() => exclude(editing, !editing.excluded)}
        >
          {t(editing.excluded ? "includeInTrend" : "ignoreInTrend")}
        </Button>
      )}
      {editing && (
        <Button variant="destructive" icon="delete" disabled={busy} onPress={remove}>
          {t("delete")}
        </Button>
      )}
    </Editor>
  );
}
