import { Feather } from "@expo/vector-icons";
import { useThemeColor } from "heroui-native";
import { Timeline } from "heroui-native-pro";
import { View } from "react-native";
import { SystemButton, SystemLabel, SystemText as Text } from "@/components/system";
import { useStore } from "@/lib/store";
import type { MeasurementLogState } from "./use-measurement-log";

export function MeasurementHistory({ log }: { log: MeasurementLogState }) {
  const { t, date, number } = useStore();
  const foreground = useThemeColor("foreground");
  const { rows, fields, format, limit, setLimit, launch, exclude } = log;

  return (
    <>
      <SystemLabel accessibilityRole="header" className="-mb-2 px-1">
        {t("history")} · {number(rows.length, 0)}
      </SystemLabel>
      {!rows.length ? (
        <Text className="py-8 text-center text-muted">{t("empty")}</Text>
      ) : (
        <Timeline size="sm">
          {rows.slice(0, limit).map((row, index) => (
            <Timeline.Item key={row.id} status={index === 0 ? "current" : "default"}>
              <Timeline.Rail />
              <Timeline.Content className="gap-3">
                <View className="flex-row items-center justify-between gap-3">
                  <Timeline.Title
                    className={`flex-1 font-mono text-sm ${row.excluded ? "opacity-50" : ""}`}
                  >
                    {date(row.measuredAt)}
                  </Timeline.Title>
                  {row.excluded && exclude && (
                    <SystemButton
                      variant="ghost"
                      className="px-3"
                      labelClassName="text-accent-soft-foreground"
                      accessibilityLabel={`Include ${date(row.measuredAt)} in your trend`}
                      onPress={() => exclude(row, false)}
                    >
                      Include
                    </SystemButton>
                  )}
                  <SystemButton
                    isIconOnly
                    variant="ghost"
                    className="h-11 w-11 p-0"
                    accessibilityLabel={`${t("edit")} · ${date(row.measuredAt)}`}
                    onPress={() => launch(row)}
                  >
                    <Feather name="edit-2" size={18} color={foreground} />
                  </SystemButton>
                </View>
                {fields
                  .filter((key) => row.values[key] !== undefined)
                  .map((key) => (
                    <View
                      key={key}
                      className={`flex-row flex-wrap justify-between gap-x-4 gap-y-1 ${row.excluded ? "opacity-50" : ""}`}
                    >
                      <Timeline.Description className="text-sm">
                        {row.excluded ? `${t(key)} · Ignored` : t(key)}
                      </Timeline.Description>
                      <Text
                        className={`font-mono tabular-nums ${row.excluded ? "line-through" : ""}`}
                      >
                        {format(key, row.values[key])}
                      </Text>
                    </View>
                  ))}
              </Timeline.Content>
            </Timeline.Item>
          ))}
        </Timeline>
      )}
      {rows.length > limit && (
        <SystemButton variant="ghost" onPress={() => setLimit(limit + 30)}>
          {t("history")} +30
        </SystemButton>
      )}
    </>
  );
}
