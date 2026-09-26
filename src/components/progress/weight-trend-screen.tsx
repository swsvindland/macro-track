import { useState } from "react";
import { View } from "react-native";
import { router } from "expo-router";
import { useThemeColor } from "heroui-native";
import { SystemButton, SystemIconButton, SystemText as Text } from "@/components/system";
import { useMeasurementLog } from "@/components/measurements/use-measurement-log";
import { WeightForm } from "@/components/measurements/weight-form";
import { currentGoal } from "@/lib/coaching-store";
import {
  formatWeight,
  fromKg,
  localDay,
  shortDay,
  weightTrend,
  weightUnit,
  type TrendPoint,
} from "@/lib/metrics";
import { useNutritionQuery } from "@/lib/nutrition-store";
import { useStore } from "@/lib/store";
import {
  Legend,
  RangeChips,
  RangeSummary,
  TrendChart,
  daysBetween,
  rangeStart,
  type Range,
} from "./chart";
import { DetailScreen, Explainer } from "./detail-screen";

/** Just enough decimals for a round axis value: 80, 80.5 or 12.25. */
const decimals = (tick: number) =>
  [0, 1].find((digits) => Math.abs(tick * 10 ** digits - Math.round(tick * 10 ** digits)) < 1e-6) ??
  2;

export function WeightTrendScreen() {
  const { weights, units, number, language, date, t } = useStore();
  const [accent, muted, success] = useThemeColor(["accent-soft-foreground", "muted", "success"]);
  const log = useMeasurementLog("weight");
  const { today, goalKg } = useNutritionQuery(() => {
    const goal = currentGoal();
    return {
      today: localDay(),
      goalKg: goal?.program && goal.mode !== "manual" ? goal.program.targetWeightKg : null,
    };
  });
  const [range, setRange] = useState<Range>("1M"),
    [scrub, setScrub] = useState<string | null>(null);
  const trend = weightTrend(weights);
  const from = rangeStart(range, today, trend[0]?.day ?? today);
  const shown = trend.filter((point) => point.day >= from && point.day <= today);
  const digits = units === "stone" ? 2 : 1;
  const value = (kg: number) => number(fromKg(kg, units), digits);
  const unit = weightUnit(units);
  const at = scrub
    ? shown.reduce<TrendPoint | null>(
        (best, point) =>
          !best || Math.abs(daysBetween(point.day, scrub)) < Math.abs(daysBetween(best.day, scrub))
            ? point
            : best,
        null
      )
    : null;
  const first = shown[0],
    last = shown.at(-1);
  const difference = first && last ? fromKg(last.trend - first.trend, units) : 0;
  const shownDifference = number(Math.abs(difference), digits);
  const sign = shownDifference === number(0, digits) ? "" : difference < 0 ? "−" : "+";
  const add = () => log.launch(null);
  return (
    <>
      <DetailScreen
        title="Weight trend"
        action={
          <SystemIconButton
            icon="add"
            accessibilityLabel={`${t("add")} · ${t("weight")}`}
            onPress={add}
          />
        }
      >
        {first && last ? (
          <>
            {at ? (
              <RangeSummary
                stats={[
                  { label: "Trend", value: value(at.trend), unit },
                  { label: "Scale", value: value(at.raw), unit },
                ]}
                caption={shortDay(at.day, language, true)}
              />
            ) : (
              <RangeSummary
                stats={[
                  {
                    label: "Average",
                    value: value(shown.reduce((sum, point) => sum + point.trend, 0) / shown.length),
                    unit,
                  },
                  { label: "Difference", value: `${sign}${shownDifference}`, unit },
                ]}
                caption={`${shortDay(first.day, language)} – ${date(last.day)}`}
              />
            )}
            <TrendChart
              from={from}
              to={today}
              lines={[
                {
                  key: "scale",
                  segments: [
                    shown.map((point) => ({ day: point.day, value: fromKg(point.raw, units) })),
                  ],
                  color: muted,
                  width: 1.5,
                  opacity: 0.8,
                },
                {
                  key: "trend",
                  segments: [
                    shown.map((point) => ({ day: point.day, value: fromKg(point.trend, units) })),
                  ],
                  color: accent,
                  dots: true,
                },
              ]}
              goal={
                goalKg === null
                  ? undefined
                  : {
                      value: fromKg(goalKg, units),
                      label: `Goal ${formatWeight(goalKg, units, number)}`,
                    }
              }
              minSpan={fromKg(1, units)}
              format={(tick) => number(tick, decimals(tick))}
              label={`Trend weight, ${shortDay(first.day, language)} to ${shortDay(last.day, language)}: ${value(first.trend)} to ${value(last.trend)} ${unit}`}
              scrub={scrub}
              onScrub={setScrub}
            />
          </>
        ) : (
          <Text className="py-6 text-center text-muted">
            {trend.length ? "No weigh-ins in this range." : t("needWeight")}
          </Text>
        )}
        <RangeChips value={range} onChange={setRange} />
        <Legend
          items={[
            {
              label: "Scale weight",
              swatch: (
                <View className="h-0.5 w-4 rounded-full" style={{ backgroundColor: muted }} />
              ),
            },
            {
              label: "Trend weight",
              swatch: (
                <View
                  className="h-2.5 w-2.5 rounded-full border-2"
                  style={{ borderColor: accent }}
                />
              ),
            },
            ...(goalKg === null
              ? []
              : [
                  {
                    label: "Goal",
                    swatch: (
                      <View className="w-4 flex-row gap-0.5">
                        <View className="h-0.5 flex-1" style={{ backgroundColor: success }} />
                        <View className="h-0.5 flex-1" style={{ backgroundColor: success }} />
                      </View>
                    ),
                  },
                ]),
          ]}
        />
        <SystemButton
          variant="secondary"
          icon="list-outline"
          labelClassName="text-foreground"
          onPress={() => router.push("/weight-history")}
        >
          {`All weigh-ins · ${number(weights.length, 0)}`}
        </SystemButton>
        <Explainer title="What is weight trend?">
          <Text className="text-sm text-muted">
            Scale weight moves day to day with water, salt, carbs and digestion. Trend weight
            averages each day’s readings and smooths them with a seven-day half-life, so it shows
            where your weight is really heading.
          </Text>
          <Text className="text-sm text-muted">
            Check-ins and the expenditure estimate use the trend. Ignored readings stay in your
            history but are left out.
          </Text>
          <SystemButton
            variant="ghost"
            className="self-start px-0"
            labelClassName="text-accent-soft-foreground"
            onPress={() => router.push("/health-sources")}
          >
            {t("sourcesTitle")}
          </SystemButton>
        </Explainer>
      </DetailScreen>
      <WeightForm log={log} />
    </>
  );
}
