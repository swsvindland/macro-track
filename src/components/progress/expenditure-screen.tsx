import { useState } from "react";
import { router } from "expo-router";
import {
  LinkButton,
  Note,
  RangeChips,
  RangeSummary,
  SystemState,
  TrendChart,
  rangeStart,
  useKitFormat,
  type ChartLine,
  type ChartPoint,
  type Range,
} from "@/vector";
import { checkInEstimates, expenditureSeries, type ExpenditurePoint } from "@/lib/insights";
import { localDay, shortDay } from "@/lib/metrics";
import { useNutritionQuery } from "@/lib/nutrition-store";
import { useStore } from "@/lib/store";
import { DetailScreen, Explainer } from "./detail-screen";

/** A diary day as a local calendar date, at noon so no time zone moves it. */
const dateOf = (day: string) => new Date(`${day}T12:00:00`);

/** Runs of estimated and holding days; each run ends on the next one's first day so they join. */
function runs(points: ExpenditurePoint[]) {
  const learned: ChartPoint[][] = [],
    holding: ChartPoint[][] = [];
  let run: ChartPoint[] = [];
  points.forEach((point, i) => {
    run.push({ day: point.day, value: point.kcal });
    const next = points[i + 1];
    if (!next || next.holding !== point.holding) {
      if (next) run.push({ day: next.day, value: next.kcal });
      (point.holding ? holding : learned).push(run);
      run = [];
    }
  });
  return { learned, holding };
}

export function ExpenditureScreen() {
  const { weights, t } = useStore();
  const format = useKitFormat();
  const data = useNutritionQuery(() => {
    const today = localDay();
    return { today, points: expenditureSeries("", today, weights), checkIns: checkInEstimates() };
  }, [weights]);
  const [range, setRange] = useState<Range>("3M"),
    [scrub, setScrub] = useState<string | null>(null);
  const { today, points } = data;
  const from = rangeStart(range, today, points[0]?.day ?? today);
  const shown = points.filter((point) => point.day >= from);
  const { learned, holding } = runs(shown);
  const kcal = (value: number) => format.number(value);
  const at = scrub ? shown.find((point) => point.day === scrub) : undefined;
  const first = shown[0],
    last = shown.at(-1);
  // Both kinds of run are the subject: the estimate, drawn dashed while it holds.
  const lines: ChartLine[] = [
    ...learned.map((run) => ({
      points: run,
      role: "subject" as const,
      style: "line" as const,
      label: t("expenditure"),
    })),
    ...holding.map((run) => ({
      points: run,
      role: "subject" as const,
      style: "dashed" as const,
      label: t("holding"),
    })),
  ];
  return (
    <DetailScreen title={t("expenditure")}>
      {first && last ? (
        <>
          {at ? (
            <RangeSummary
              label={shortDay(at.day, format.tag, true)}
              value={kcal(at.kcal)}
              unit={t("kcal")}
              meta={[
                t("rangeKcal", { range: format.range(at.low, at.high) }),
                at.holding ? t("holding") : "",
              ]}
            />
          ) : (
            <RangeSummary
              label={t("average")}
              value={kcal(shown.reduce((sum, point) => sum + point.kcal, 0) / shown.length)}
              unit={t("kcal")}
              delta={format.number(last.kcal - first.kcal, 0, true)}
              meta={[format.dateRange(dateOf(first.day), dateOf(last.day))]}
            />
          )}
          <TrendChart
            from={from}
            to={today}
            lines={lines}
            band={{ points: shown, label: t("estimateRange") }}
            markers={{
              points: data.checkIns.map((row) => ({ day: row.day, value: row.kcal })),
              label: data.checkIns.some((row) => row.day >= from) ? t("checkIn") : undefined,
            }}
            minSpan={300}
            yFormat={kcal}
            summary={t("expenditureChartSummary", {
              from: shortDay(first.day, format.tag),
              to: shortDay(last.day, format.tag),
              start: kcal(first.kcal),
              end: kcal(last.kcal),
            })}
            onScrub={(point) => setScrub(point?.day ?? null)}
          />
          <RangeChips value={range} onChange={setRange} accessibilityLabel={t("chartRange")} />
        </>
      ) : (
        <SystemState kind="empty" code={t("noEstimateYet")} message={t("noEstimateHelp")} />
      )}
      <Explainer title={t("howExpenditureEstimated")}>
        <Note>{t("expenditureExplainerMethod")}</Note>
        <Note>{t("expenditureExplainerHolding")}</Note>
        <LinkButton icon="forward" onPress={() => router.push("/coaching-method")}>
          {t("coachingMethodTitle")}
        </LinkButton>
      </Explainer>
    </DetailScreen>
  );
}
