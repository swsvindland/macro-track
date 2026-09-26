import { useState } from "react";
import { View } from "react-native";
import { router } from "expo-router";
import { useThemeColor } from "heroui-native";
import { SystemButton, SystemPanel, SystemText as Text } from "@/components/system";
import { checkInEstimates, expenditureSeries, type ExpenditurePoint } from "@/lib/insights";
import { localDay, shortDay } from "@/lib/metrics";
import { useNutritionQuery } from "@/lib/nutrition-store";
import { useStore } from "@/lib/store";
import {
  Legend,
  RangeChips,
  RangeSummary,
  TrendChart,
  rangeStart,
  type ChartPoint,
  type Range,
} from "./chart";
import { DetailScreen, Explainer } from "./detail-screen";

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
  const { weights, number, language, date } = useStore();
  const [accent, foreground] = useThemeColor(["accent-soft-foreground", "foreground"]);
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
  const kcal = (value: number) => number(value, 0);
  const at = scrub ? shown.find((point) => point.day === scrub) : undefined;
  const first = shown[0],
    last = shown.at(-1);
  return (
    <DetailScreen title="Expenditure">
      {first && last ? (
        <>
          {at ? (
            <RangeSummary
              stats={[
                { label: "Estimate", value: kcal(at.kcal), unit: "kcal" },
                { label: "Range", value: `${kcal(at.low)}–${kcal(at.high)}`, unit: "kcal" },
              ]}
              caption={`${shortDay(at.day, language, true)}${at.holding ? " · Holding" : ""}`}
            />
          ) : (
            <RangeSummary
              stats={[
                {
                  label: "Average",
                  value: kcal(shown.reduce((sum, point) => sum + point.kcal, 0) / shown.length),
                  unit: "kcal",
                },
                {
                  label: "Difference",
                  value: `${last.kcal < first.kcal ? "−" : last.kcal > first.kcal ? "+" : ""}${kcal(Math.abs(last.kcal - first.kcal))}`,
                  unit: "kcal",
                },
              ]}
              caption={`${shortDay(first.day, language)} – ${date(last.day)}`}
            />
          )}
          <TrendChart
            from={from}
            to={today}
            lines={[
              { key: "estimate", segments: learned, color: accent },
              { key: "holding", segments: holding, color: accent, dashed: true },
            ]}
            band={{ points: shown, color: accent }}
            markers={{
              points: data.checkIns.map((row) => ({ day: row.day, value: row.kcal })),
              color: foreground,
            }}
            minSpan={300}
            format={(value) => number(value, 0)}
            label={`Estimated expenditure, ${shortDay(first.day, language)} to ${shortDay(last.day, language)}: ${kcal(first.kcal)} to ${kcal(last.kcal)} kcal a day`}
            scrub={scrub}
            onScrub={setScrub}
          />
          <RangeChips value={range} onChange={setRange} />
          <Legend
            items={[
              {
                label: "Range",
                swatch: (
                  <View
                    className="h-3 w-4 rounded-sm"
                    style={{ backgroundColor: accent, opacity: 0.3 }}
                  />
                ),
              },
              {
                label: "Expenditure",
                swatch: (
                  <View className="h-0.5 w-4 rounded-full" style={{ backgroundColor: accent }} />
                ),
              },
              {
                label: "Holding",
                swatch: (
                  <View className="w-4 flex-row gap-1">
                    <View
                      className="h-0.5 flex-1 rounded-full"
                      style={{ backgroundColor: accent }}
                    />
                    <View
                      className="h-0.5 flex-1 rounded-full"
                      style={{ backgroundColor: accent }}
                    />
                  </View>
                ),
              },
              ...(data.checkIns.some((row) => row.day >= from)
                ? [
                    {
                      label: "Check-in",
                      swatch: (
                        <View
                          className="h-2.5 w-2.5 rounded-sm border-2"
                          style={{ borderColor: foreground }}
                        />
                      ),
                    },
                  ]
                : []),
            ]}
          />
        </>
      ) : (
        <SystemPanel className="p-4">
          <SystemPanel.Body className="gap-2">
            <Text className="font-semibold">No estimate yet</Text>
            <Text className="text-sm text-muted">
              Mark days complete and weigh in regularly. The estimate starts once three weeks hold
              12 usable days and six weigh-ins, or from your program’s starting estimate.
            </Text>
          </SystemPanel.Body>
        </SystemPanel>
      )}
      <Explainer title="How is expenditure estimated?">
        <Text className="text-sm text-muted">
          Each day looks back 21 days. Complete and fasting days, in runs of at least seven, are
          matched to the change in your weight trend at 7,700 kcal per kg: what you ate minus the
          energy that went into or came out of storage. Day-to-day values are smoothed.
        </Text>
        <Text className="text-sm text-muted">
          Without enough new evidence the estimate holds. The shaded range narrows with more usable
          days and steadier weigh-ins. Check-ins use the same evidence but move more slowly, so
          their numbers can differ a little. It is an estimate, not a measurement.
        </Text>
        <SystemButton
          variant="ghost"
          className="self-start px-0"
          labelClassName="text-accent-soft-foreground"
          onPress={() => router.push("/coaching-method")}
        >
          How check-ins work
        </SystemButton>
      </Explainer>
    </DetailScreen>
  );
}
