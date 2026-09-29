import { Fragment } from "react";
import { View } from "react-native";
import { Button, Panel, RecordRow, SystemState, Value, useKitFormat } from "@/vector";
import { useStore } from "@/lib/store";
import type { MeasurementLogState } from "./use-measurement-log";

/** A stored reading's moment: a bare day is read at noon, so no time zone moves it. */
const when = (value: string) => new Date(value.length === 10 ? `${value}T12:00:00` : value);

export function MeasurementHistory({ log }: { log: MeasurementLogState }) {
  const { t } = useStore();
  const format = useKitFormat();
  const { rows, fields, readout, limit, setLimit, launch, exclude } = log;
  if (!rows.length) return <SystemState kind="empty" code={t("history")} message={t("empty")} />;
  return (
    <>
      <Panel inset="none">
        <Panel.Header eyebrow={t("history")} meta={format.number(rows.length)} />
        {rows.slice(0, limit).map((row) => {
          const shown = fields.filter((key) => row.values[key] !== undefined);
          const date = format.date(when(row.measuredAt), "short");
          return (
            <Fragment key={row.id}>
              {shown.map((key, i) => (
                <RecordRow
                  key={key}
                  // A reading's date heads its first row only.
                  time={i === 0 ? date : ""}
                  title={t(key)}
                  description={row.excluded ? t("ignoredInTrend") : undefined}
                  value={
                    <Value
                      {...readout(key, row.values[key])}
                      tone={row.excluded ? "muted" : "default"}
                    />
                  }
                  onPress={() => launch(row)}
                  accessibilityActions={
                    row.excluded && exclude ? [{ name: "include", label: t("includeInTrend") }] : []
                  }
                  onAccessibilityAction={(event) => {
                    if (event.nativeEvent.actionName === "include") exclude?.(row, false);
                  }}
                />
              ))}
              {/* An ignored weigh-in counts again in one tap. */}
              {row.excluded && exclude && (
                <View className="px-4 pb-2">
                  <Button
                    variant="ghost"
                    className="self-start"
                    onPress={() => exclude(row, false)}
                  >
                    {t("includeInTrend")}
                  </Button>
                </View>
              )}
            </Fragment>
          );
        })}
      </Panel>
      {rows.length > limit && (
        <Button variant="ghost" onPress={() => setLimit(limit + 30)}>
          {t("showMore", { count: format.number(30) })}
        </Button>
      )}
    </>
  );
}
