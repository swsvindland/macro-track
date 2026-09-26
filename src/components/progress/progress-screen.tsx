import { useState } from "react";
import { Pressable, View } from "react-native";
import { router, useIsFocused } from "expo-router";
import { useCalendars } from "expo-localization";
import { useThemeColor } from "heroui-native";
import { Segment } from "heroui-native-pro";
import {
  SystemButton,
  SystemIcon,
  SystemIconButton,
  SystemLabel,
  SystemPanel,
  SystemText as Text,
} from "@/components/system";
import { Screen } from "@/components/ui";
import { useMeasurementLog } from "@/components/measurements/use-measurement-log";
import { WeightForm } from "@/components/measurements/weight-form";
import {
  progressSnapshot,
  weekBudget,
  weekDays,
  weekStart,
  type ProgressSnapshot,
  type WeekBudget,
  type WeekDay,
} from "@/lib/insights";
import { formatPace, formatWeight, fromKg, localDay, shortDay, weightUnit } from "@/lib/metrics";
import { shiftDay } from "@/lib/nutrition";
import { useNutrition } from "@/lib/nutrition-store";
import { useStore } from "@/lib/store";
import { Sparkline, type ChartPoint } from "./chart";

const rows = [
  { key: "calories", unit: "kcal", name: "Calories", fill: "bg-chart-calories" },
  { key: "protein", unit: "P", name: "Protein", fill: "bg-chart-protein" },
  { key: "fat", unit: "F", name: "Fat", fill: "bg-chart-fat" },
  { key: "carbs", unit: "C", name: "Carbs", fill: "bg-chart-carbs" },
] as const;
const BAR = 40;
/** A day before the last seven. */
const stale = (day: string, today: string) => day < shiftDay(today, -6);

/** Eaten against a day's target: a tick for the target, a fill for what was eaten or is left. */
function DayBar({
  eaten,
  target,
  remaining,
  fill,
  future,
}: {
  eaten: number;
  target: number | null;
  remaining: boolean;
  fill: string;
  future: boolean;
}) {
  const scale = Math.max((target ?? 0) * 1.2, remaining ? 0 : eaten, 1);
  const value = future ? 0 : remaining ? Math.max((target ?? 0) - eaten, 0) : eaten;
  return (
    <View className="w-2 rounded-full bg-surface-secondary" style={{ height: BAR }}>
      {value > 0 && (
        <View
          className={`absolute bottom-0 w-full rounded-full ${fill}`}
          style={{ height: Math.max(3, (Math.min(value, scale) / scale) * BAR) }}
        />
      )}
      {!!target && (
        <View
          className={`absolute h-0.5 rounded-full ${future ? "bg-muted" : "bg-foreground"}`}
          style={{ left: -3, right: -3, bottom: (target / scale) * BAR - 1 }}
        />
      )}
    </View>
  );
}

/** The week's four rows of daily bars, with the chosen day's numbers on the right. */
export function WeeklyNutrition({
  today,
  current,
  first,
  days: daysFor,
}: {
  today: string;
  /** The first day of this week. */
  current: string;
  /** The first day with data; earlier weeks are empty. */
  first: string;
  days: (start: string) => WeekDay[];
}) {
  const { number, language } = useStore();
  // Weeks back from this one, so a new week opens on itself.
  const [back, setBack] = useState(0),
    [picked, setPicked] = useState<string | null>(null),
    [remaining, setRemaining] = useState(false);
  const start = shiftDay(current, -7 * back);
  const days = daysFor(start);
  const end = days[6].day;
  const selected =
    days.find((day) => day.day === picked) ?? days.find((day) => day.day === today) ?? days[6];
  const title =
    back === 0
      ? "This week"
      : back === 1
        ? "Last week"
        : `${shortDay(start, language)} – ${shortDay(end, language)}`;
  const letter = (day: string) =>
    new Date(`${day}T12:00:00`).toLocaleDateString(language === "zh" ? "zh-CN" : language, {
      weekday: "narrow",
    });
  const describe = (day: WeekDay) =>
    `${shortDay(day.day, language, true)}: ${
      day.day > today
        ? "upcoming"
        : rows
            .map(
              (row) =>
                `${row.name} ${number(day.eaten[row.key], 0)}${day.target ? ` of ${number(day.target[row.key], 0)}` : ""}`
            )
            .join(", ")
    }`;
  const figure = (row: (typeof rows)[number]) => {
    const eaten = selected.eaten[row.key],
      target = selected.target?.[row.key];
    if (!remaining || target === undefined)
      return {
        value: number(eaten, 0),
        note: target === undefined ? "no target" : `of ${number(target, 0)}`,
        over: false,
      };
    const left = target - (selected.day > today ? 0 : eaten);
    return { value: number(Math.abs(left), 0), note: left < 0 ? "over" : "left", over: left < 0 };
  };
  return (
    <SystemPanel className="p-4">
      <SystemPanel.Body className="gap-3">
        <View className="-mx-2 -my-2 flex-row items-center">
          <SystemIconButton
            icon="chevron-back"
            accessibilityLabel="Previous week"
            isDisabled={start <= first}
            color={start <= first ? "muted" : "foreground"}
            onPress={() => setBack(back + 1)}
          />
          <Text accessibilityRole="header" className="flex-1 text-center font-semibold">
            {title}
          </Text>
          <SystemIconButton
            icon="chevron-forward"
            accessibilityLabel="Next week"
            isDisabled={back === 0}
            color={back === 0 ? "muted" : "foreground"}
            onPress={() => setBack(Math.max(0, back - 1))}
          />
        </View>
        <View className="flex-row">
          <View className="flex-1 flex-row">
            {days.map((day) => {
              const active = day.day === selected.day;
              return (
                <Pressable
                  key={day.day}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                  accessibilityLabel={describe(day)}
                  onPress={() => setPicked(day.day)}
                  className={`flex-1 items-center gap-3 rounded-2xl border pt-2 pb-1.5 ${active ? "border-foreground" : "border-transparent"}`}
                >
                  {rows.map((row) => (
                    <DayBar
                      key={row.key}
                      eaten={day.eaten[row.key]}
                      target={day.target?.[row.key] ?? null}
                      remaining={remaining}
                      fill={row.fill}
                      future={day.day > today}
                    />
                  ))}
                  <Text
                    className={`text-xs ${day.day === today ? "font-semibold text-foreground" : "text-muted"}`}
                    maxFontSizeMultiplier={1.2}
                  >
                    {letter(day.day)}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          <View className="gap-3 pl-2" style={{ width: 80, paddingTop: 9 }}>
            {rows.map((row) => {
              const { value, note, over } = figure(row);
              return (
                <View key={row.key} className="justify-center" style={{ height: BAR }}>
                  <Text
                    className="font-semibold tabular-nums"
                    numberOfLines={1}
                    adjustsFontSizeToFit
                    maxFontSizeMultiplier={1.2}
                  >
                    {value}
                    <Text className="text-xs font-medium text-muted"> {row.unit}</Text>
                  </Text>
                  <Text
                    className={`text-xs tabular-nums ${over ? "text-warning" : "text-muted"}`}
                    numberOfLines={1}
                    maxFontSizeMultiplier={1.2}
                  >
                    {note}
                  </Text>
                </View>
              );
            })}
          </View>
        </View>
        <Segment
          value={remaining ? "remaining" : "consumed"}
          size="sm"
          onValueChange={(value) => setRemaining(value === "remaining")}
        >
          <Segment.Group className="self-center">
            <Segment.Indicator />
            <Segment.Item value="consumed">
              <Segment.Label>Consumed</Segment.Label>
            </Segment.Item>
            <Segment.Item value="remaining">
              <Segment.Label>Remaining</Segment.Label>
            </Segment.Item>
          </Segment.Group>
        </Segment>
      </SystemPanel.Body>
    </SystemPanel>
  );
}

function InsightCard({
  title,
  caption = "Last 7 days",
  value,
  unit,
  points,
  band,
  minSpan,
  href,
}: {
  title: string;
  caption?: string;
  value: string;
  unit: string;
  points: ChartPoint[];
  band?: { day: string; low: number; high: number }[];
  minSpan: number;
  href: "/expenditure" | "/weight-trend";
}) {
  const accent = useThemeColor("accent-soft-foreground");
  return (
    <Pressable
      className="flex-1"
      accessibilityRole="button"
      accessibilityLabel={`${title}, ${caption}: ${value} ${unit}`}
      onPress={() => router.push(href)}
    >
      {({ pressed }) => (
        <SystemPanel className={`flex-1 p-4 ${pressed ? "opacity-70" : ""}`}>
          <SystemPanel.Body className="gap-2">
            <View>
              <Text className="font-semibold" numberOfLines={1}>
                {title}
              </Text>
              <Text className="text-xs text-muted">{caption}</Text>
            </View>
            <Sparkline points={points} band={band} color={accent} minSpan={minSpan} />
            <View className="flex-row items-center border-t border-separator pt-2">
              <Text
                className="flex-1 text-xl font-semibold tabular-nums"
                numberOfLines={1}
                adjustsFontSizeToFit
                maxFontSizeMultiplier={1.3}
              >
                {value}
                <Text className="text-sm font-medium text-muted"> {unit}</Text>
              </Text>
              <SystemIcon name="chevron-forward" size={16} color="muted" />
            </View>
          </SystemPanel.Body>
        </SystemPanel>
      )}
    </Pressable>
  );
}

function Row({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <View className="gap-0.5">
      <View className="flex-row items-baseline justify-between gap-3">
        <Text className="text-sm text-muted">{label}</Text>
        <Text className="font-semibold tabular-nums" maxFontSizeMultiplier={1.3}>
          {value}
        </Text>
      </View>
      {!!note && <Text className="text-sm text-muted tabular-nums">{note}</Text>}
    </View>
  );
}

/** The week against its budget, the goal's date and the next check-in. */
export function ThisWeek({ budget, data }: { budget: WeekBudget; data: ProgressSnapshot }) {
  const { number, units, language } = useStore();
  const { today, projection, pace, coached, due } = data;
  const weight = (kg: number) => formatWeight(kg, units, number);
  const percent = (value: number | null) => (value === null ? "—" : `${number(value * 100, 0)}%`);
  const eta = (day: string) =>
    day.slice(0, 4) === today.slice(0, 4)
      ? shortDay(day, language)
      : new Date(`${day}T12:00:00`).toLocaleDateString(language === "zh" ? "zh-CN" : language, {
          month: "short",
          year: "numeric",
        });
  const hasTargets = !!data.targetOn(today);
  const round = (kcal: number) => number(Math.abs(Math.round(kcal / 10) * 10), 0);
  const line =
    budget.restPerDay !== null
      ? `~${round(budget.restPerDay)} kcal/day for the rest of the week lands on budget`
      : budget.balance === null
        ? null
        : Math.abs(budget.balance) < 5
          ? "On this week’s budget"
          : `${round(budget.balance)} kcal ${budget.balance > 0 ? "over" : "under"} this week’s budget`;
  const latest = data.trend.at(-1);
  const trend = latest
    ? `Trend ${weight(latest.trend)}${stale(latest.day, today) ? ` on ${shortDay(latest.day, language)}` : ""}${pace === null ? "" : ` · ${formatPace(pace, units, number)}`}`
    : null;
  const goal = (() => {
    if (!projection) return null;
    const { mode, targetKg, weightKg, reached } = projection;
    if (weightKg === null) return "Add a weigh-in";
    if (mode === "maintain")
      return reached
        ? "In range"
        : `${weight(Math.abs(weightKg - targetKg))} ${weightKg > targetKg ? "above" : "below"}`;
    return reached ? "Reached" : projection.eta ? `~${eta(projection.eta)}` : "—";
  })();
  // Manual targets early in the week with no weigh-ins have nothing to summarize yet.
  if (budget.average === null && !line && !goal && !trend && hasTargets && !coached) return null;
  return (
    <SystemPanel className="p-4">
      <SystemPanel.Body className="gap-3">
        <SystemLabel>Week so far</SystemLabel>
        {budget.average !== null && budget.averageTarget !== null ? (
          <Row
            label="Average intake"
            value={`${number(budget.average, 0)} / ${number(budget.averageTarget, 0)} kcal`}
            note={`${budget.days} complete ${budget.days === 1 ? "day" : "days"} · Protein ${percent(budget.adherence.protein)} · Carbs ${percent(budget.adherence.carbs)} · Fat ${percent(budget.adherence.fat)}`}
          />
        ) : (
          !hasTargets && (
            <Text className="text-sm text-muted">
              Set targets in Plan to see your week against a budget.
            </Text>
          )
        )}
        {!!line && <Text className="font-medium tabular-nums">{line}</Text>}
        {projection && goal ? (
          <Row
            label={`${projection.mode === "maintain" ? "Maintaining" : "Goal"} ${weight(projection.targetKg)}`}
            value={goal}
            note={trend ?? undefined}
          />
        ) : (
          trend && <Text className="text-sm text-muted tabular-nums">{trend}</Text>
        )}
        {(coached || !hasTargets) && (
          <SystemButton variant="secondary" onPress={() => router.navigate("/(tabs)/plan")}>
            {coached && due
              ? due <= today
                ? "Review check-in"
                : `Next check-in · ${shortDay(due, language, true)}`
              : "Set up your plan"}
          </SystemButton>
        )}
      </SystemPanel.Body>
    </SystemPanel>
  );
}

/**
 * Progress's reads, once per data change and only while the tab is on screen: changes made
 * elsewhere are read once on return, and returning with none reads nothing. Like
 * useNutritionQuery, it opts out of React Compiler so every write reaches the read.
 */
function useProgressSnapshot() {
  "use no memo";
  const { revision } = useNutrition();
  const { weights } = useStore();
  const focused = useIsFocused();
  const read = () => ({ revision, weights, data: progressSnapshot(localDay(), weights) });
  const [kept, setKept] = useState(read);
  if (focused && (kept.revision !== revision || kept.weights !== weights)) setKept(read());
  return kept.data;
}

export function ProgressScreen() {
  const { units, number, language, t } = useStore();
  const calendar = useCalendars()[0];
  const weight = useMeasurementLog("weight");
  const data = useProgressSnapshot();
  const { today, intake, targetOn, trend, expenditure } = data;
  // expo-localization counts weekdays from 1 for Sunday.
  const current = weekStart(today, (calendar?.firstWeekday ?? 2) - 1);
  const days = (start: string) => weekDays(start, intake, targetOn);
  const latest = trend.at(-1);
  // With no weigh-in in the last seven days, the card shows the seven up to the last one, dated.
  const end = latest && stale(latest.day, today) ? latest.day : today;
  const weightPoints = trend
    .filter((point) => point.day >= shiftDay(end, -6))
    .map((point) => ({ day: point.day, value: fromKg(point.trend, units) }));
  const estimate = expenditure.at(-1);
  return (
    <>
      <Screen
        title="Progress"
        action={
          <SystemIconButton
            icon="scale-outline"
            variant="secondary"
            accessibilityLabel={`${t("add")} · ${t("weight")}`}
            onPress={() => weight.launch(null)}
          />
        }
      >
        <WeeklyNutrition today={today} current={current} first={data.first} days={days} />
        <View className="flex-row gap-3">
          <InsightCard
            title="Expenditure"
            value={estimate ? number(estimate.kcal, 0) : "—"}
            unit="kcal"
            points={expenditure.map((point) => ({ day: point.day, value: point.kcal }))}
            band={expenditure}
            minSpan={150}
            href="/expenditure"
          />
          <InsightCard
            title="Weight trend"
            caption={end < today ? `As of ${shortDay(end, language)}` : undefined}
            value={latest ? number(fromKg(latest.trend, units), units === "stone" ? 2 : 1) : "—"}
            unit={weightUnit(units)}
            points={weightPoints}
            minSpan={fromKg(0.5, units)}
            href="/weight-trend"
          />
        </View>
        <ThisWeek budget={weekBudget(days(current), today)} data={data} />
      </Screen>
      <WeightForm log={weight} />
    </>
  );
}
