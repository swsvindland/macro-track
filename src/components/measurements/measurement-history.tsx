import { Feather } from "@expo/vector-icons";
import { useThemeColor } from "heroui-native";
import { Timeline } from "heroui-native-pro";
import { View } from "react-native";
import { SystemButton, SystemText as Text } from "@/components/system";
import { useStore } from "@/lib/store";
import type { MeasurementLogState } from "./use-measurement-log";

export function MeasurementHistory({ log }: { log: MeasurementLogState }) {
  const { t, date, number } = useStore();
  const foreground = useThemeColor("foreground");
  const { rows, fields, format, limit, setLimit, launch } = log;

  return (
    <>
      <Text accessibilityRole="header" className="text-xl font-semibold text-foreground">
        {t("history")} · {number(rows.length, 0)}
      </Text>
      {!rows.length ? (
        <Text className="py-8 text-center text-muted">{t("empty")}</Text>
      ) : (
        <Timeline size="sm">
          {rows.slice(0, limit).map((row, index) => (
            <Timeline.Item key={row.id} status={index === 0 ? "current" : "default"}>
              <Timeline.Rail />
              <Timeline.Content className="gap-3">
                <View className="flex-row items-center justify-between gap-3">
                  <Timeline.Title className="flex-1 font-mono text-sm">
                    {date(row.measuredAt)}
                  </Timeline.Title>
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
                    <View key={key} className="flex-row flex-wrap justify-between gap-x-4 gap-y-1">
                      <Timeline.Description className="text-sm">{t(key)}</Timeline.Description>
                      <Text className="font-mono tabular-nums">{format(key, row.values[key])}</Text>
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
