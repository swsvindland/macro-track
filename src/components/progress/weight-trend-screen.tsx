import { useState } from "react";
import { router } from "expo-router";
import {
  Button,
  LinkButton,
  Note,
  RangeChips,
  RangeSummary,
  SystemState,
  TrendChart,
  rangeStart,
  useKitFormat,
  type IntlUnit,
  type Range,
} from "@/vector";
import { useMeasurementLog } from "@/components/measurements/use-measurement-log";
import { WeightForm } from "@/components/measurements/weight-form";
import { currentGoal } from "@/lib/coaching-store";
import { formatWeight, fromKg, localDay, shortDay, weightTrend, type Units } from "@/lib/metrics";
import { useNutritionQuery } from "@/lib/nutrition-store";
import { useStore } from "@/lib/store";
import { DetailScreen, Explainer } from "./detail-screen";

/** The unit a weight readout is written in, as the locale spells it. */
const massUnits: Record<Units, IntlUnit> = {
  metric: "kilogram",
  imperial: "pound",
  stone: "stone",
};
/** Just enough decimals for a round axis value: 80, 80.5 or 12.25. */
const decimals = (tick: number) =>
  [0, 1].find((digits) => Math.abs(tick * 10 ** digits - Math.round(tick * 10 ** digits)) < 1e-6) ??
  2;
/** A diary day as a local calendar date, at noon so no time zone moves it. */
const dateOf = (day: string) => new Date(`${day}T12:00:00`);

export function WeightTrendScreen() {
  const { weights, units, t } = useStore();
  const format = useKitFormat();
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
  const unit = massUnits[units];
  // Fixed decimals, as the history and the check-in write weights ("80.0 kg").
  const fixed = { fixed: true };
  const readout = (kg: number) => format.unitParts(fromKg(kg, units), unit, digits, fixed);
  const at = scrub ? shown.find((point) => point.day === scrub) : undefined;
  const first = shown[0],
    last = shown.at(-1);
  // The signed readout reads the rounded value: a change that shows as zero carries no sign.
  const difference = first && last ? fromKg(last.trend - first.trend, units) : 0;
  const add = () => log.launch(null);
  return (
    <>
      <DetailScreen
        title={t("weightTrend")}
        action={{ icon: "add", accessibilityLabel: t("logWeight"), onPress: add }}
      >
        {first && last ? (
          <>
            {at ? (
              <RangeSummary
                label={shortDay(at.day, format.tag, true)}
                {...readout(at.trend)}
                meta={[t("scaleReading", { weight: formatWeight(at.raw, units, format) })]}
              />
            ) : (
              <RangeSummary
                label={t("average")}
                {...readout(shown.reduce((sum, point) => sum + point.trend, 0) / shown.length)}
                delta={format.number(difference, digits, true)}
                meta={[format.dateRange(dateOf(first.day), dateOf(last.day))]}
              />
            )}
            <TrendChart
              from={from}
              to={today}
              lines={[
                {
                  points: shown.map((point) => ({
                    day: point.day,
                    value: fromKg(point.raw, units),
                  })),
                  role: "reference",
                  style: "dots",
                  label: t("scaleWeight"),
                },
                {
                  points: shown.map((point) => ({
                    day: point.day,
                    value: fromKg(point.trend, units),
                  })),
                  role: "subject",
                  label: t("trend"),
                },
              ]}
              goal={
                goalKg === null
                  ? undefined
                  : {
                      value: fromKg(goalKg, units),
                      label: formatWeight(goalKg, units, format),
                    }
              }
              minSpan={fromKg(1, units)}
              yFormat={(tick) => format.number(tick, decimals(tick))}
              summary={t("trendChartSummary", {
                from: shortDay(first.day, format.tag),
                to: shortDay(last.day, format.tag),
                start: format.unit(fromKg(first.trend, units), unit, digits, fixed),
                end: format.unit(fromKg(last.trend, units), unit, digits, fixed),
              })}
              onScrub={(point) => setScrub(point?.day ?? null)}
            />
          </>
        ) : (
          <SystemState
            kind="empty"
            message={trend.length ? t("noWeighInsInRange") : t("needWeight")}
          />
        )}
        <RangeChips value={range} onChange={setRange} accessibilityLabel={t("chartRange")} />
        <Button variant="secondary" icon="history" onPress={() => router.push("/weight-history")}>
          {t("allWeighIns", { count: format.number(weights.length) })}
        </Button>
        <Explainer title={t("whatIsWeightTrend")}>
          <Note>{t("weightTrendExplainerScale")}</Note>
          <Note>{t("weightTrendExplainerUse")}</Note>
          <LinkButton icon="forward" onPress={() => router.push("/health-sources")}>
            {t("sourcesTitle")}
          </LinkButton>
        </Explainer>
      </DetailScreen>
      <WeightForm log={log} />
    </>
  );
}
