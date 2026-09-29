import { useState } from "react";
import { Pressable, View } from "react-native";
import { router, useIsFocused } from "expo-router";
import { useCalendars } from "expo-localization";
import {
  Button,
  Heading,
  Icon,
  IconButton,
  Meta,
  Note,
  Panel,
  Sparkline,
  Text,
  Value,
  useKitFormat,
  type ChartPoint,
  type IntlUnit,
} from "@/vector";
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
import { formatPace, formatWeight, fromKg, localDay, shortDay, type Units } from "@/lib/metrics";
import { shiftDay } from "@/lib/nutrition";
import { useNutrition } from "@/lib/nutrition-store";
import { useStore } from "@/lib/store";

// Calories, then P · C · F on the ink ramp.
const rows = [
  { key: "calories", name: "calories", short: null, fill: "bg-tint" },
  { key: "protein", name: "macroProtein", short: "proteinShort", fill: "bg-cat-1" },
  { key: "carbs", name: "macroCarbs", short: "carbsShort", fill: "bg-cat-2" },
  { key: "fat", name: "macroFat", short: "fatShort", fill: "bg-cat-3" },
] as const;
const BAR = 40;
/** Two figures fill a bar's height, so they grow less than body text. */
const BAR_TEXT_CAP = 1.2;
/** The unit a weight readout is written in, as the locale spells it. */
const massUnits: Record<Units, IntlUnit> = {
  metric: "kilogram",
  imperial: "pound",
  stone: "stone",
};
/** A day before the last seven. */
const stale = (day: string, today: string) => day < shiftDay(today, -6);
/** A diary day as a local calendar date, at noon so no time zone moves it. */
const dateOf = (day: string) => new Date(`${day}T12:00:00`);

/** Eaten against a day's target: a tick for the target, a fill for what was eaten. */
function DayBar({
  eaten,
  target,
  fill,
  future,
}: {
  eaten: number;
  target: number | null;
  fill: string;
  future: boolean;
}) {
  const scale = Math.max((target ?? 0) * 1.2, eaten, 1);
  const value = future ? 0 : eaten;
  return (
    <View className="w-2 rounded-mark bg-surface-tertiary" style={{ height: BAR }}>
      {value > 0 && (
        <View
          className={`absolute bottom-0 w-full rounded-mark ${fill}`}
          style={{ height: Math.max(3, (Math.min(value, scale) / scale) * BAR) }}
        />
      )}
      {!!target && (
        <View
          className={`absolute h-0.5 rounded-mark ${future ? "bg-muted" : "bg-foreground"}`}
          style={{ left: -3, right: -3, bottom: (target / scale) * BAR - 1 }}
        />
      )}
    </View>
  );
}

/** The week's four rows of daily bars, with the chosen day's numbers at the end. */
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
  const { t } = useStore();
  const format = useKitFormat();
  // Weeks back from this one, so a new week opens on itself.
  const [back, setBack] = useState(0),
    [picked, setPicked] = useState<string | null>(null);
  const start = shiftDay(current, -7 * back);
  const days = daysFor(start);
  const end = days[6].day;
  const selected =
    days.find((day) => day.day === picked) ?? days.find((day) => day.day === today) ?? days[6];
  const title =
    back === 0
      ? t("thisWeek")
      : back === 1
        ? t("lastWeek")
        : format.dateRange(dateOf(start), dateOf(end));
  const letter = (day: string) => format.weekdayNarrow(dateOf(day));
  const describe = (day: WeekDay) => {
    const name = shortDay(day.day, format.tag, true);
    if (day.day > today) return t("weekDayUpcoming", { day: name });
    const amounts = rows.map((row) => {
      const values = {
        name: t(row.name),
        eaten: format.number(day.eaten[row.key]),
        target: day.target ? format.number(day.target[row.key]) : "",
      };
      return t(day.target ? "amountOfTarget" : "amountEaten", values);
    });
    return t("weekDaySummary", { day: name, summary: format.list(amounts) });
  };
  return (
    <Panel>
      <Panel.Body>
        <View className="flex-row items-center">
          <IconButton
            icon="back"
            accessibilityLabel={t("previousWeek")}
            disabled={start <= first}
            onPress={() => setBack(back + 1)}
          />
          <Heading level={4} className="flex-1 text-center">
            {title}
          </Heading>
          <IconButton
            icon="forward"
            accessibilityLabel={t("nextWeek")}
            disabled={back === 0}
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
                  className={`flex-1 items-center gap-3 rounded-control border pt-2 pb-1.5 ${active ? "border-foreground" : "border-transparent"}`}
                >
                  {rows.map((row) => (
                    <DayBar
                      key={row.key}
                      eaten={day.eaten[row.key]}
                      target={day.target?.[row.key] ?? null}
                      fill={row.fill}
                      future={day.day > today}
                    />
                  ))}
                  <Text
                    variant="caption"
                    tone={day.day === today ? "default" : "muted"}
                    maxFontSizeMultiplier={1.2}
                  >
                    {letter(day.day)}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          {/* Grows with its figures instead of a fixed width. */}
          <View className="min-w-20 gap-3 ps-2" style={{ paddingTop: 9 }}>
            {rows.map((row) => {
              const eaten = selected.eaten[row.key],
                target = selected.target?.[row.key];
              const value = format.number(eaten);
              return (
                <View key={row.key} className="justify-center" style={{ height: BAR }}>
                  {row.short ? (
                    <Text variant="readoutS" maxFontSizeMultiplier={BAR_TEXT_CAP}>
                      {t(row.short, { value })}
                    </Text>
                  ) : (
                    <Value value={value} unit={t("kcal")} maxFontSizeMultiplier={BAR_TEXT_CAP} />
                  )}
                  <Text
                    variant="readoutXS"
                    tone={target !== undefined && eaten > target ? "warning" : "muted"}
                    maxFontSizeMultiplier={BAR_TEXT_CAP}
                  >
                    {target === undefined
                      ? t("noTarget")
                      : t("ofTarget", { target: format.number(target) })}
                  </Text>
                </View>
              );
            })}
          </View>
        </View>
      </Panel.Body>
    </Panel>
  );
}

function InsightCard({
  title,
  caption,
  value,
  unit,
  unitFirst,
  space,
  spoken,
  points,
  band,
  minSpan,
  href,
}: {
  title: string;
  caption?: string;
  value: string;
  unit: string;
  unitFirst?: boolean;
  space?: string;
  /** The readout as a screen reader says it, unit included. */
  spoken: string;
  points: ChartPoint[];
  band?: { day: string; low: number; high: number }[];
  minSpan: number;
  href: "/expenditure" | "/weight-trend";
}) {
  const { t } = useStore();
  const shownCaption = caption ?? t("last7Days");
  return (
    <Panel
      className="flex-1"
      accessibilityLabel={t("insightSummary", { title, caption: shownCaption, value: spoken })}
      onPress={() => router.push(href)}
    >
      <Panel.Body className="gap-2">
        <View>
          <Heading level={4}>{title}</Heading>
          <Text variant="caption" tone="muted">
            {shownCaption}
          </Text>
        </View>
        <Sparkline points={points} band={band} minSpan={minSpan} />
        <View className="flex-row items-center gap-1 border-t border-separator pt-2">
          {/* A half-width tile: one line that shrinks before it clips. */}
          <View className="flex-1">
            <Value
              size="m"
              value={value}
              unit={unit}
              unitFirst={unitFirst}
              space={space}
              numberOfLines={1}
              adjustsFontSizeToFit
              maxFontSizeMultiplier={1.3}
            />
          </View>
          <Icon name="forward" size={16} tone="muted" />
        </View>
      </Panel.Body>
    </Panel>
  );
}

function Row({ label, value, note }: { label: string; value: string; note?: string[] }) {
  return (
    <View className="gap-0.5">
      <View className="flex-row flex-wrap items-baseline justify-between gap-x-3">
        <Note>{label}</Note>
        <Text variant="readoutS">{value}</Text>
      </View>
      {!!note?.length && <Meta items={note} />}
    </View>
  );
}

/** The week against its budget, the goal's date and the next check-in. */
export function ThisWeek({ budget, data }: { budget: WeekBudget; data: ProgressSnapshot }) {
  const { units, t } = useStore();
  const format = useKitFormat();
  const { today, projection, pace, coached, due } = data;
  const weight = (kg: number) => formatWeight(kg, units, format);
  const percent = (value: number | null) => (value === null ? "—" : format.percent(value));
  const eta = (day: string) =>
    day.slice(0, 4) === today.slice(0, 4)
      ? shortDay(day, format.tag)
      : format.monthYear(dateOf(day), "short");
  const hasTargets = !!data.targetOn(today);
  const round = (kcal: number) => format.number(Math.abs(Math.round(kcal / 10) * 10));
  const line =
    budget.restPerDay !== null
      ? t("restOfWeekPace", { value: round(budget.restPerDay) })
      : budget.balance === null
        ? null
        : Math.abs(budget.balance) < 5
          ? t("onWeekBudget")
          : t(budget.balance > 0 ? "overWeekBudget" : "underWeekBudget", {
              value: round(budget.balance),
            });
  const latest = data.trend.at(-1);
  const trend = latest
    ? [
        stale(latest.day, today)
          ? t("trendWeightOn", {
              weight: weight(latest.trend),
              day: shortDay(latest.day, format.tag),
            })
          : t("trendWeightValue", { weight: weight(latest.trend) }),
        pace === null ? "" : formatPace(pace, units, format, t),
      ].filter(Boolean)
    : null;
  const goal = (() => {
    if (!projection) return null;
    const { mode, targetKg, weightKg, reached } = projection;
    if (weightKg === null) return t("addWeighIn");
    if (mode === "maintain")
      return reached
        ? t("inRange")
        : t(weightKg > targetKg ? "weightAbove" : "weightBelow", {
            weight: weight(Math.abs(weightKg - targetKg)),
          });
    return reached
      ? t("goalReached")
      : projection.eta
        ? t("aroundDay", { day: eta(projection.eta) })
        : "—";
  })();
  // Manual targets early in the week with no weigh-ins have nothing to summarize yet.
  if (budget.average === null && !line && !goal && !trend && hasTargets && !coached) return null;
  return (
    <Panel>
      <Panel.Header eyebrow={t("weekSoFar")} />
      <Panel.Body>
        {budget.average !== null && budget.averageTarget !== null ? (
          <Row
            label={t("averageIntake")}
            value={t("kcalOfBudget", {
              eaten: format.number(budget.average),
              target: format.number(budget.averageTarget),
            })}
            note={[
              t(format.plural(budget.days) === "one" ? "completeDayCountOne" : "completeDayCount", {
                count: format.number(budget.days),
              }),
              t("proteinPercent", { percent: percent(budget.adherence.protein) }),
              t("carbsPercent", { percent: percent(budget.adherence.carbs) }),
              t("fatPercent", { percent: percent(budget.adherence.fat) }),
            ]}
          />
        ) : (
          !hasTargets && <Note>{t("setTargetsForBudget")}</Note>
        )}
        {!!line && <Text variant="bodyStrong">{line}</Text>}
        {projection && goal ? (
          <Row
            label={t(projection.mode === "maintain" ? "maintainingWeight" : "goalWeightValue", {
              weight: weight(projection.targetKg),
            })}
            value={goal}
            note={trend ?? undefined}
          />
        ) : (
          trend && <Meta items={trend} />
        )}
        {(coached || !hasTargets) && (
          <Button variant="secondary" onPress={() => router.navigate("/(tabs)/plan")}>
            {coached && due
              ? due <= today
                ? t("reviewCheckIn")
                : t("nextCheckInOn", { day: shortDay(due, format.tag, true) })
              : t("setUpYourPlan")}
          </Button>
        )}
      </Panel.Body>
    </Panel>
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
  const { units, t } = useStore();
  const format = useKitFormat();
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
  const digits = units === "stone" ? 2 : 1;
  // Fixed decimals, as the history and the check-in write weights ("80.0 kg").
  const trendReadout = latest
    ? format.unitParts(fromKg(latest.trend, units), massUnits[units], digits, { fixed: true })
    : null;
  return (
    <>
      <Screen
        title={t("progress")}
        action={
          <IconButton
            icon="scale"
            variant="secondary"
            accessibilityLabel={t("logWeight")}
            onPress={() => weight.launch(null)}
          />
        }
      >
        <WeeklyNutrition today={today} current={current} first={data.first} days={days} />
        <View className="flex-row gap-3">
          <InsightCard
            title={t("expenditure")}
            value={estimate ? format.number(estimate.kcal) : "—"}
            unit={t("kcal")}
            spoken={estimate ? t("kcalValue", { value: format.number(estimate.kcal) }) : "—"}
            points={expenditure.map((point) => ({ day: point.day, value: point.kcal }))}
            band={expenditure}
            minSpan={150}
            href="/expenditure"
          />
          <InsightCard
            title={t("weightTrend")}
            caption={end < today ? t("asOfDay", { day: shortDay(end, format.tag) }) : undefined}
            value={trendReadout?.value ?? "—"}
            unit={trendReadout?.unit ?? ""}
            unitFirst={trendReadout?.unitFirst}
            space={trendReadout?.space}
            spoken={
              latest
                ? format.unit(fromKg(latest.trend, units), massUnits[units], digits, {
                    fixed: true,
                  })
                : "—"
            }
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
