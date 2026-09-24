import { useState } from "react";
import { router } from "expo-router";
import { View, useWindowDimensions } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Popover, useThemeColor } from "heroui-native";
import {
  SystemButton,
  SystemLabel,
  SystemValue,
  SystemPanel,
  SystemText as Text,
} from "@/components/system";
import Svg, { Circle, Line, Path } from "react-native-svg";
import { useStore } from "@/lib/store";
import {
  metricContext,
  shoulderWaistRatio,
  type DashboardMetric,
  type MetricTone,
} from "@/lib/metric-context";
import { bodyFat, composition, fromKg, weightTrend, weightUnit } from "@/lib/metrics";

const contextColors: Record<MetricTone, string> = {
  neutral: "text-muted",
  info: "text-accent-soft-foreground",
  success: "text-success-soft-foreground",
  warning: "text-warning-soft-foreground",
  danger: "text-danger-soft-foreground",
};

function DashboardCardHeader({ title, help }: { title: string; help: string }) {
  const { t } = useStore();
  const muted = useThemeColor("muted");
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [isOpen, setIsOpen] = useState(false);

  return (
    <View className="-my-3 -mr-3 flex-row items-center gap-2">
      <SystemLabel className="flex-1">{title}</SystemLabel>
      <Popover isOpen={isOpen} onOpenChange={setIsOpen}>
        <Popover.Trigger asChild>
          <SystemButton
            isIconOnly
            variant="ghost"
            className="h-11 w-11 p-0"
            accessibilityLabel={`${t("metricInfo")} · ${title}`}
          >
            <Feather name="help-circle" size={18} color={muted} />
          </SystemButton>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Overlay />
          <Popover.Content
            presentation="popover"
            placement="bottom"
            align="end"
            width={Math.min(300, width - insets.left - insets.right - 32)}
            insets={{ top: insets.top + 8, bottom: insets.bottom + 8, left: 16, right: 16 }}
            className="gap-2 rounded-md p-3"
          >
            <View className="flex-row items-center gap-2">
              <Popover.Title className="flex-1 font-sans">{title}</Popover.Title>
              <Popover.Close accessibilityLabel={t("close")} />
            </View>
            <Popover.Description className="font-sans text-sm">{help}</Popover.Description>
            <SystemButton
              variant="ghost"
              onPress={() => {
                setIsOpen(false);
                router.push("/health-sources");
              }}
            >
              {t("sourcesTitle")}
            </SystemButton>
          </Popover.Content>
        </Popover.Portal>
      </Popover>
    </View>
  );
}

export function Dashboard() {
  const { weights, measurements, units, formula, t, number, date } = useStore();
  const trend = weightTrend(weights);
  const latest = trend.at(-1);
  const heightEntry = measurements.find((m) => m.kind === "height");
  const bodyEntry = measurements.find((m) => m.kind === "body");
  const ratioEntry = measurements.find(
    (m) => m.kind === "body" && shoulderWaistRatio(m.values) !== null
  );
  const ratio = shoulderWaistRatio(ratioEntry?.values);
  const height = heightEntry?.values.height;
  const fat = bodyFat(bodyEntry?.values, height, formula);
  const { bmi, ffmi } = composition(latest?.trend, height, fat);
  const [width, setWidth] = useState(0);
  const accent = String(useThemeColor("accent"));
  const muted = String(useThemeColor("muted"));
  const border = String(useThemeColor("separator"));
  const visible = trend.filter(
    (p) => Date.parse(p.day) >= Date.parse(latest?.day ?? "2000-01-01") - 90 * 86400000
  );
  const values = visible.flatMap((p) => [p.raw, p.trend]);
  const min = Math.min(...values) - 0.5;
  const max = Math.max(...values) + 0.5;
  const start = Date.parse(visible[0]?.day ?? "2000-01-01");
  const end = Date.parse(latest?.day ?? "2000-01-01");
  const x = (day: string) =>
    10 +
    (end === start ? 0.5 : (Date.parse(day) - start) / (end - start)) * Math.max(width - 20, 1);
  const y = (value: number) => 12 + ((max - value) / (max - min)) * 140;
  return (
    <View className="gap-4">
      <SystemButton
        variant="ghost"
        className="self-start"
        onPress={() => router.push("/health-sources")}
      >
        {t("sourcesTitle")}
      </SystemButton>
      <SystemPanel>
        <SystemPanel.Body className="gap-3">
          <DashboardCardHeader title={t("trend")} help={t("trendHelp")} />
          <SystemValue>
            {latest ? number(fromKg(latest.trend, units)) : "—"}{" "}
            <Text className="font-mono text-lg text-muted">{weightUnit(units)}</Text>
          </SystemValue>
          <Text className="text-sm text-muted">
            {latest
              ? `${t("asOf")} ${date(latest.day)} · ${t("latest")}: ${number(fromKg(weights[0].weightKg, units))} ${weightUnit(units)}`
              : t("needWeight")}
          </Text>
          {latest && (
            <View
              onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
              style={{ height: 170 }}
            >
              {width > 0 && latest && (
                <Svg
                  width={width}
                  height={170}
                  accessible
                  accessibilityRole="image"
                  accessibilityLabel={`${t("trend")}: ${number(fromKg(latest.trend, units))} ${weightUnit(units)}. ${t("asOf")} ${date(latest.day)}`}
                >
                  {[12, 82, 152].map((position) => (
                    <Line
                      key={position}
                      x1={0}
                      x2={width}
                      y1={position}
                      y2={position}
                      stroke={border}
                      strokeWidth={1}
                    />
                  ))}
                  {visible.map((point) => (
                    <Circle
                      key={point.day}
                      cx={x(point.day)}
                      cy={y(point.raw)}
                      r={3}
                      fill={muted}
                      opacity={0.65}
                    />
                  ))}
                  <Path
                    d={visible
                      .map((p, i) => `${i ? "L" : "M"} ${x(p.day)} ${y(p.trend)}`)
                      .join(" ")}
                    stroke={accent}
                    strokeWidth={2}
                    fill="none"
                  />
                  <Circle cx={x(latest.day)} cy={y(latest.trend)} r={4} fill={accent} />
                </Svg>
              )}
            </View>
          )}
          {latest && (
            <View className="flex-row justify-between">
              <Text className="font-mono text-xs text-muted">{date(visible[0].day)}</Text>
              <Text className="font-mono text-xs text-muted">{date(latest.day)}</Text>
            </View>
          )}
          <View className="flex-row flex-wrap gap-4 border-t border-separator pt-3">
            <Text className="text-xs text-muted">● {t("weight")}</Text>
            <Text className="text-xs text-link">— {t("trend")}</Text>
          </View>
        </SystemPanel.Body>
      </SystemPanel>
      <View className="flex-row flex-wrap gap-3">
        {(
          [
            { key: "bmi", value: bmi },
            { key: "bodyFat", value: fat },
            { key: "ffmi", value: ffmi },
            { key: "shoulderWaistRatio", value: ratio },
          ] satisfies { key: DashboardMetric; value: number | null }[]
        ).map((metric) => {
          const context = metricContext(metric.key, metric.value, formula);
          return (
            <SystemPanel key={metric.key} style={{ flexGrow: 1, flexBasis: 160 }}>
              <SystemPanel.Body className="gap-2">
                <DashboardCardHeader
                  title={t(metric.key)}
                  help={[
                    t(context.help),
                    ...(metric.key === "shoulderWaistRatio"
                      ? [`${t("ratioGoal")}: ${number(1.62, 2)}`]
                      : []),
                    ...(context.range
                      ? [
                          `${t("metricReference")}: ${context.range.map((v) => number(v)).join("–")}${metric.key === "bodyFat" ? "%" : ""}${metric.key !== "bmi" ? ` (${t(formula)})` : ""}`,
                        ]
                      : []),
                  ].join(" · ")}
                />
                <Text className="text-2xl font-mono tabular-nums text-foreground">
                  {metric.value === null
                    ? "—"
                    : number(metric.value, metric.key === "shoulderWaistRatio" ? 2 : 1)}
                  {metric.key === "bodyFat" && metric.value !== null ? "%" : ""}
                </Text>
                <Text className={`text-sm font-medium ${contextColors[context.tone]}`}>
                  {t(context.label)}
                </Text>
                <Text className="mt-auto pt-1 font-mono text-xs text-muted">
                  {metric.value === null
                    ? `${t("add")} · ${t(metric.key === "bodyFat" || metric.key === "shoulderWaistRatio" ? "measurements" : !height ? "height" : !latest ? "weight" : "measurements")}`
                    : metric.key === "shoulderWaistRatio"
                      ? `${t("shoulders")} ÷ ${t("waist")} · ${date(ratioEntry!.measuredAt)}`
                      : metric.key === "bmi"
                        ? `${t("height")} · ${date(heightEntry!.measuredAt)}`
                        : `${t(bodyEntry?.values.bodyFat ? "bodyFat" : "estimated")} · ${date(bodyEntry!.measuredAt)}`}
                </Text>
              </SystemPanel.Body>
            </SystemPanel>
          );
        })}
      </View>
    </View>
  );
}
