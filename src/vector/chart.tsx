import { useMemo, useState } from "react";
import {
  View,
  useWindowDimensions,
  type GestureResponderEvent,
  type ViewStyle,
} from "react-native";
import Svg, { Circle, Line, Path, Rect } from "react-native-svg";
import { twMerge } from "tailwind-merge";
import { useCSSVariable } from "uniwind";
import { Choices } from "./form";
import type { Format } from "./format";
import { Icon } from "./icon";
import { useKit, useKitFormat, useKitStrings, webHidden } from "./provider";
import { Label, Meta, Text, Value } from "./text";

// Charts take data and translated words through props; locale and formatting come from the kit. No store, no
// app formatter, no colour props: the subject line is always tint, reference data always muted (design-system §2.5).

const DAY = 86400000;
/** Days from `from` to `to`; fractional for date-times. */
export const daysBetween = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / DAY;
const addDays = (day: string, days: number) =>
  new Date(Date.parse(day) + days * DAY).toISOString().slice(0, 10);

export const ranges = ["1W", "1M", "3M", "6M", "1Y", "All"] as const;
export type Range = (typeof ranges)[number];
const rangeDays = { "1W": 7, "1M": 30, "3M": 91, "6M": 182, "1Y": 365 } as const;
const rangeUnit = {
  "1W": [1, "week"],
  "1M": [1, "month"],
  "3M": [3, "month"],
  "6M": [6, "month"],
  "1Y": [1, "year"],
} as const;

/** The first day a range shows up to `to`, never before the first day with data and never after `to`. */
export function rangeStart(range: Range, to: string, first: string): string {
  const start = range === "All" ? first : addDays(to, 1 - rangeDays[range]);
  return start > first ? (start < to ? start : to) : first < to ? first : to;
}

/**
 * A dated value. `day` is an ISO date (YYYY-MM-DD) or, for a Sparkline over hours (water BAC), an ISO date-time;
 * x is proportional to time. Use one form per chart: a bare date parses as UTC, a date-time without Z as local.
 */
export type ChartPoint = { day: string; value: number };
/** A flat range around a series (expenditure estimate): tint at 10%, no gradient. */
export type ChartBandPoint = { day: string; low: number; high: number };
/**
 * What one point stands for. `day`: a reading on that day (or an average of that day). `week` / `month` / `year`: an
 * aggregate of the period that starts on the point's day (fitness-native's weekly, monthly and yearly averages).
 */
export type ChartGranularity = "day" | "week" | "month" | "year";

/**
 * The name of the period a point stands for, for the RangeSummary eyebrow while scrubbing and for summaries: the
 * day (medium date), the week ("Sep 22 – 28, 2026", seven days from `day`), the month ("September 2026") or the year.
 */
export function periodLabel(format: Format, day: string, granularity: ChartGranularity = "day") {
  const d = day.length === 10 ? new Date(`${day}T12:00:00`) : new Date(day);
  switch (granularity) {
    case "week":
      return format.dateRange(d, new Date(d.getTime() + 6 * DAY), { year: true });
    case "month":
      return format.monthYear(d);
    case "year":
      return format.year(d);
    default:
      return format.date(d, "medium");
  }
}

export type ChartLine = {
  points: ChartPoint[];
  /** subject: what the chart is about (2pt tint). reference: raw points, a previous period (muted). */
  role: "subject" | "reference";
  /** Default: line for a subject, dots for a reference. A series split into runs is several lines. */
  style?: "line" | "dots" | "dashed";
  /** Legend entry. With two or more labelled series the chart draws its own Legend. */
  label?: string;
};

type Scale = { min: number; max: number };
type XY = { x: number; y: number };

/** A y scale over the values: at least `minSpan` tall, padded 8% so marks clear the edges; `zero` pins the floor. */
export function chartScale(values: number[], minSpan = 0, zero = false): Scale {
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (zero) {
    min = Math.min(min, 0);
    max = Math.max(max, 0);
  }
  // A flat series still needs height, or one reading would sit on a grid of rounding noise.
  const need = minSpan > 0 ? minSpan : max === min ? Math.max(Math.abs(max) * 0.1, 1) : 0;
  if (max - min < need) {
    if (zero && min === 0) max = need;
    else {
      const middle = (min + max) / 2;
      min = middle - need / 2;
      max = middle + need / 2;
    }
  }
  const pad = (max - min) * 0.08;
  return { min: zero && min === 0 ? 0 : min - pad, max: max + pad };
}

/** 3–5 round values inside the scale (1, 2, 2.5 or 5 × 10ⁿ apart): the grid lines and the y ticks. */
export function chartTicks({ min, max }: Scale): number[] {
  const span = max - min;
  if (!(span > 0)) return [min];
  const power = 10 ** Math.floor(Math.log10(span / 4));
  for (const p of [power / 10, power, power * 10]) {
    for (const factor of [1, 2, 2.5, 5]) {
      const step = factor * p;
      const first = Math.ceil(min / step);
      const count = Math.floor(max / step) - first + 1;
      if (count <= 5) {
        // Round to the step's own precision: 0.1 + 0.2 must label as 0.3. `+ 0` turns -0 into 0.
        const digits = Math.max(0, 1 - Math.floor(Math.log10(step)));
        return Array.from(
          { length: count },
          (_, i) => Number(((first + i) * step).toFixed(digits)) + 0
        );
      }
    }
  }
  return [min, max];
}

const path = (points: XY[]) =>
  points.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join("");
const area = (upper: XY[], lower: XY[]) =>
  `${path(upper)}${path([...lower].reverse()).replace("M", "L")}Z`;
/** Skips dots within 2pt of the last one drawn: "All" over years of weigh-ins stays a readable band of dots. */
const thin = <T extends XY>(points: T[]) => {
  let last = -Infinity;
  return points.filter((p) => {
    if (Math.abs(p.x - last) < 2) return false;
    last = p.x;
    return true;
  });
};
const extent = (days: string[]) =>
  days.length
    ? days.reduce(([lo, hi], d) => [d < lo ? d : lo, d > hi ? d : hi] as [string, string], [
        days[0],
        days[0],
      ] as [string, string])
    : null;
const latestOf = (points: ChartPoint[]) =>
  points.reduce<ChartPoint | null>((best, p) => (!best || p.day >= best.day ? p : best), null);
const same = (a: ChartPoint | null, b: ChartPoint | null) =>
  a === b || (!!a && !!b && a.day === b.day && a.value === b.value);

// Svg takes colour strings, not classes. These follow the theme (and ScopedTheme) at runtime; the chart-1…5
// tokens are aliases of exactly these, so the referents are read directly.
const chartVars = [
  "--color-tint",
  "--color-muted",
  "--color-foreground-secondary",
  "--color-separator",
  "--color-border",
  "--color-surface",
  "--color-foreground",
];
function useChartColors() {
  const [subject, reference, target, grid, baseline, surface, ink] = useCSSVariable(chartVars).map(
    (v) => (v === undefined ? "transparent" : String(v))
  );
  return { subject, reference, target, grid, baseline, surface, ink };
}

const dateTickOptions = {
  day: { month: "short", day: "numeric" },
  month: { month: "short" },
  year: { month: "short", year: "numeric" },
  yearOnly: { year: "numeric" },
} satisfies Record<string, Intl.DateTimeFormatOptions>;

/**
 * 3–4 date ticks from `start` to `end`: the first aligns to start, the last to end. With `periods` (the days of
 * period aggregates) the ticks sit on those days, so a month or year label never falls between two points.
 */
export function chartDayTicks(start: string, end: string, periods: string[] = []): string[] {
  const days = [...new Set(periods)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (days.length)
    return [...new Set([0, 1, 2, 3].map((i) => days[Math.round(((days.length - 1) * i) / 3)]))];
  const span = Math.max(daysBetween(start, end), 0) || 0;
  return span > 0
    ? [...new Set([0, 1, 2, 3].map((i) => addDays(start, Math.round((span * i) / 3))))]
    : [start];
}

/** The first day after the period that starts on `day` (the day after it for daily points). */
function periodEnd(day: string, granularity: ChartGranularity): string {
  if (granularity === "day") return addDays(day, 1);
  if (granularity === "week") return addDays(day, 7);
  const d = new Date(Date.parse(day));
  if (granularity === "month") d.setUTCMonth(d.getUTCMonth() + 1);
  else d.setUTCFullYear(d.getUTCFullYear() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Where a chart of period aggregates starts: a point keyed by its period's first day still counts when its period
 * overlaps `from` (September, keyed Sep 1, for a range from Sep 29), so the domain starts at the first such period
 * instead of dropping it. Daily points, and periods that start on or after `from`, leave `from` as it is.
 */
export function chartDomainStart(
  from: string,
  days: string[],
  granularity: ChartGranularity = "day"
): string {
  if (granularity === "day" || !from) return from;
  let start = from;
  for (const day of days) if (day < start && periodEnd(day, granularity) > from) start = day;
  return start;
}

/** Chart overlays never take a touch (react-native-web wants pointerEvents as a style, not a prop). */
const noTouch: ViewStyle = { pointerEvents: "none" };

/** Axis ticks keep their slot: capped at 1.3× text size (design-system §3.5). */
const TICK_CAP = 1.3;
/** y ticks sit in an end-side gutter (they mirror with the layout). */
const GUTTER = 44;
const TOP = 8;
const BOTTOM = 8;
/** Keeps the first and last points (and the solid latest dot) inside the Svg. */
const INSET = 4;

/** A goal line's tag at the end of the line: GOAL + readout; off the scale it sits at the edge with a glyph. */
function GoalTag({ label, off }: { label: string; off?: "above" | "below" }) {
  const strings = useKitStrings();
  return (
    <View className="flex-row items-center gap-1 rounded-mark bg-surface px-1">
      {off ? (
        <View style={off === "above" ? { transform: [{ rotate: "180deg" }] } : undefined}>
          <Icon name="down" size={12} tone="muted" />
        </View>
      ) : null}
      <Label tone="secondary" maxFontSizeMultiplier={TICK_CAP}>
        {strings.goal}
      </Label>
      <Text variant="readoutXS" tone="secondary" numberOfLines={1} maxFontSizeMultiplier={TICK_CAP}>
        {label}
      </Text>
    </View>
  );
}

export type TrendChartProps = {
  lines: ChartLine[];
  /** 1pt dashed target line; `label` is the formatted readout ("78 kg"), shown after the kit's GOAL. */
  goal?: { value: number; label: string };
  band?: { points: ChartBandPoint[]; label?: string };
  /** Discrete events on the series (macro check-ins): 8pt hollow squares in ink. */
  markers?: { points: ChartPoint[]; label?: string };
  /** The shown domain, usually rangeStart(range, today, first) … today. Default: the data's own first and last day. */
  from?: string;
  to?: string;
  /** Smallest y span in data units, so a flat week is not drawn as noise (2 kg, 300 kcal). */
  minSpan?: number;
  /** Start the y scale at zero: amounts from nothing (volume, BAC), not levels (body weight). */
  zero?: boolean;
  /** Default 200, or 260 on windows 600pt and wider. */
  height?: number;
  /**
   * Points are period aggregates keyed by each period's first day (weekly, monthly, yearly averages): the date
   * ticks sit on the data's own periods and read in that period's terms (a month, a year). Name a scrubbed point
   * with `periodLabel(format, point.day, granularity)`. Default: dated readings with evenly spaced date ticks.
   */
  granularity?: ChartGranularity;
  /** y tick labels, e.g. `(n) => format.number(n)`. */
  yFormat: (value: number) => string;
  /** What VoiceOver reads for the chart: range, min, max, latest and direction. */
  summary: string;
  /** Press-and-drag: the nearest subject point, then null on release. Update a RangeSummary from it. */
  onScrub?: (point: ChartPoint | null) => void;
};

/**
 * A dated line chart on a panel surface: 3–5 separator grid lines over a border baseline, y ticks in an end-side
 * gutter, 3–4 date ticks, and press-and-drag scrubbing with a 1pt ink rule (no tooltip; the RangeSummary above
 * is the readout). Under RTL the Svg is mirrored and every label is RN Text laid out outside it.
 */
export function TrendChart({
  lines,
  goal,
  band,
  markers,
  from,
  to,
  minSpan = 0,
  zero = false,
  height,
  granularity,
  yFormat,
  summary,
  onScrub,
}: TrendChartProps) {
  const { isRTL, fontScale } = useKit();
  const format = useKitFormat();
  const strings = useKitStrings();
  const color = useChartColors();
  const { width: window } = useWindowDimensions();
  const [plot, setPlot] = useState(0);
  const [scrub, setScrub] = useState<ChartPoint | null>(null);
  const h = height ?? (window >= 600 ? 260 : 200);
  const tickLine = Math.ceil(16 * Math.min(Math.max(fontScale, 1), TICK_CAP));
  const mirror: ViewStyle | undefined = isRTL ? { transform: [{ scaleX: -1 }] } : undefined;

  const domain = extent([
    ...lines.flatMap((l) => l.points.map((p) => p.day)),
    ...(band?.points ?? []).map((p) => p.day),
    ...(markers?.points ?? []).map((p) => p.day),
  ]);
  const periodic = !!granularity && granularity !== "day";
  const requested = from ?? domain?.[0] ?? "";
  const end = to ?? domain?.[1] ?? requested;
  // A period that overlaps `from` is drawn from its first day (its key), so the domain reaches back to it.
  const start = periodic
    ? chartDomainStart(
        requested,
        [
          ...lines.flatMap((l) => l.points.map((p) => p.day)),
          ...(band?.points ?? []).map((p) => p.day),
        ],
        granularity
      )
    : requested;
  const span = Math.max(daysBetween(start, end), 0) || 0;
  // Short day up to ~4 months, then month, plus the year past 400 days (where "Sep 24" would read as a day); a
  // monthly series names months (with the year past 400 days) and a yearly one years.
  // Memoized: scrubbing re-renders on every move and Intl formatters are costly to build on Hermes.
  const bucket =
    granularity === "year"
      ? "yearOnly"
      : granularity === "month"
        ? span > 400
          ? "year"
          : "month"
        : span <= 120
          ? "day"
          : span > 400
            ? "year"
            : "month";
  const dateFormat = useMemo(
    () => new Intl.DateTimeFormat(format.tag, dateTickOptions[bucket]),
    [format.tag, bucket]
  );
  const inside = <T extends { day: string }>(points: T[]) =>
    points.filter((p) => p.day >= start && p.day <= end);
  const drawn = lines.map((l, i) => ({
    key: `s${i}`,
    role: l.role,
    label: l.label,
    style: l.style ?? (l.role === "subject" ? "line" : "dots"),
    points: inside(l.points),
  }));
  const shownBand = band ? inside(band.points) : [];
  const shownMarks = markers ? inside(markers.points) : [];
  const values = [
    ...drawn.flatMap((l) => l.points.map((p) => p.value)),
    ...shownBand.flatMap((p) => [p.low, p.high]),
    ...shownMarks.map((p) => p.value),
  ];

  // Legend from labelled series, band and markers: required once there are two (design-system §5.9).
  const legend: LegendItem[] = [];
  const addLegend = (item: LegendItem) => {
    if (!legend.some((l) => l.label === item.label)) legend.push(item);
  };
  for (const l of drawn) if (l.label) addLegend({ label: l.label, style: l.style, role: l.role });
  if (band?.label) addLegend({ label: band.label, style: "band" });
  if (markers?.label) addLegend({ label: markers.label, style: "marker" });

  if (!values.length) {
    return (
      <View
        accessible
        accessibilityRole="image"
        accessibilityLabel={summary}
        className="items-center justify-center border-b border-border"
        style={{ height: h }}
      >
        <Label>{strings.noData}</Label>
      </View>
    );
  }

  const data = chartScale(values, minSpan, zero);
  // A goal far outside the data is tagged at the edge instead of flattening the series against it.
  const reach = data.max - data.min;
  const goalNear = !!goal && goal.value >= data.min - reach && goal.value <= data.max + reach;
  const scale = goal && goalNear ? chartScale([...values, goal.value], minSpan, zero) : data;
  const x = (day: string) =>
    INSET + (span > 0 ? daysBetween(start, day) / span : 0.5) * Math.max(plot - INSET * 2, 0);
  const y = (value: number) =>
    TOP + ((scale.max - value) / (scale.max - scale.min)) * (h - TOP - BOTTOM);
  const floor = h - BOTTOM;
  const ticks = chartTicks(scale);
  const xy = (points: ChartPoint[]) => points.map((p) => ({ x: x(p.day), y: y(p.value) }));

  const subject = drawn.filter((l) => l.role === "subject");
  const subjectPoints = subject.flatMap((l) => l.points);
  const latest = latestOf(subjectPoints);
  const scrubbable = subjectPoints.length ? subjectPoints : drawn.flatMap((l) => l.points);

  const move = (event: GestureResponderEvent) => {
    // The Svg is mirrored under RTL; the touch is not.
    const at = isRTL ? plot - event.nativeEvent.locationX : event.nativeEvent.locationX;
    let best: ChartPoint | null = null;
    for (const p of scrubbable) {
      if (!best || Math.abs(x(p.day) - at) < Math.abs(x(best.day) - at)) best = p;
    }
    if (!same(best, scrub)) {
      setScrub(best);
      onScrub?.(best);
    }
  };
  const release = () => {
    if (!scrub) return;
    setScrub(null);
    onScrub?.(null);
  };

  const dayTicks = chartDayTicks(
    start,
    end,
    periodic ? drawn.flatMap((l) => l.points.map((p) => p.day)) : []
  );
  const dayLabel = (day: string) =>
    dateFormat.format(day.length === 10 ? new Date(`${day}T12:00:00`) : new Date(day));
  const goalTop = goal && goalNear ? y(goal.value) : 0;

  return (
    <View className="gap-2">
      <View accessible accessibilityRole="image" accessibilityLabel={summary}>
        <View className="flex-row" style={{ height: h }}>
          <View
            className="flex-1"
            onLayout={(e) => setPlot(Math.round(e.nativeEvent.layout.width))}
            onStartShouldSetResponder={() => !!onScrub && scrubbable.length > 0}
            onResponderGrant={move}
            onResponderMove={move}
            onResponderRelease={release}
            onResponderTerminate={release}
          >
            {plot > 0 ? (
              <View style={mirror ? [noTouch, mirror] : noTouch}>
                <Svg width={plot} height={h}>
                  {ticks
                    .filter((t) => Math.abs(y(t) - floor) > 1)
                    .map((t) => (
                      <Line
                        key={`g${t}`}
                        x1={0}
                        x2={plot}
                        y1={y(t)}
                        y2={y(t)}
                        stroke={color.grid}
                        strokeWidth={1}
                      />
                    ))}
                  <Line
                    x1={0}
                    x2={plot}
                    y1={floor + 0.5}
                    y2={floor + 0.5}
                    stroke={color.baseline}
                    strokeWidth={1}
                  />
                  {shownBand.length > 1 ? (
                    <Path
                      d={area(
                        shownBand.map((p) => ({ x: x(p.day), y: y(p.high) })),
                        shownBand.map((p) => ({ x: x(p.day), y: y(p.low) }))
                      )}
                      fill={color.subject}
                      fillOpacity={0.1}
                    />
                  ) : null}
                  {goal && goalNear ? (
                    <Line
                      x1={0}
                      x2={plot}
                      y1={y(goal.value)}
                      y2={y(goal.value)}
                      stroke={color.target}
                      strokeWidth={1}
                      strokeDasharray="2 3"
                    />
                  ) : null}
                  {/* References under the subject; within a role, in the caller's order. */}
                  {[...drawn.filter((l) => l.role === "reference"), ...subject].map((l) =>
                    l.style === "dots" ? (
                      thin(xy(l.points)).map((p, i) =>
                        l.role === "subject" ? (
                          <Circle
                            key={`${l.key}d${i}`}
                            cx={p.x}
                            cy={p.y}
                            r={2.5}
                            fill={color.surface}
                            stroke={color.subject}
                            strokeWidth={1.5}
                          />
                        ) : (
                          <Circle
                            key={`${l.key}d${i}`}
                            cx={p.x}
                            cy={p.y}
                            r={2.5}
                            fill={color.reference}
                          />
                        )
                      )
                    ) : l.points.length > 1 ? (
                      <Path
                        key={l.key}
                        d={path(xy(l.points))}
                        stroke={l.role === "subject" ? color.subject : color.reference}
                        strokeWidth={2}
                        strokeDasharray={l.style === "dashed" ? "4 3" : undefined}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        fill="none"
                      />
                    ) : null
                  )}
                  {shownMarks.map((p) => (
                    <Rect
                      key={`m${p.day}`}
                      x={x(p.day) - 4}
                      y={y(p.value) - 4}
                      width={8}
                      height={8}
                      rx={2}
                      fill={color.surface}
                      stroke={color.ink}
                      strokeWidth={2}
                    />
                  ))}
                  {/* Hollow points only while they stay legible; the latest is always solid. */}
                  {subjectPoints.length <= 31
                    ? subject
                        .filter((l) => l.style !== "dots")
                        .flatMap((l) =>
                          l.points.map((p) => (
                            <Circle
                              key={`${l.key}p${p.day}`}
                              cx={x(p.day)}
                              cy={y(p.value)}
                              r={2.5}
                              fill={color.surface}
                              stroke={color.subject}
                              strokeWidth={1.5}
                            />
                          ))
                        )
                    : null}
                  {latest && !scrub ? (
                    <Circle cx={x(latest.day)} cy={y(latest.value)} r={3.5} fill={color.subject} />
                  ) : null}
                  {scrub ? (
                    <>
                      <Line
                        x1={x(scrub.day)}
                        x2={x(scrub.day)}
                        y1={TOP}
                        y2={floor}
                        stroke={color.ink}
                        strokeWidth={1}
                      />
                      <Circle
                        cx={x(scrub.day)}
                        cy={y(scrub.value)}
                        r={3.5}
                        fill={color.subject}
                        stroke={color.surface}
                        strokeWidth={1.5}
                      />
                    </>
                  ) : null}
                </Svg>
              </View>
            ) : null}
            {goal && plot > 0 ? (
              <View
                style={[
                  noTouch,
                  goalNear
                    ? {
                        position: "absolute",
                        end: INSET,
                        top: goalTop - tickLine - 2 < 0 ? goalTop + 2 : goalTop - tickLine - 2,
                      }
                    : goal.value < scale.min
                      ? { position: "absolute", end: INSET, bottom: BOTTOM + 2 }
                      : { position: "absolute", end: INSET, top: 0 },
                ]}
              >
                <GoalTag
                  label={goal.label}
                  off={goalNear ? undefined : goal.value < scale.min ? "below" : "above"}
                />
              </View>
            ) : null}
          </View>
          <View style={[noTouch, { width: GUTTER }]}>
            {ticks.map((t) => (
              <View
                key={`t${t}`}
                style={{
                  position: "absolute",
                  start: 6,
                  end: 0,
                  top: Math.min(Math.max(y(t) - tickLine / 2, 0), h - tickLine),
                }}
              >
                <Text
                  variant="readoutXS"
                  tone="muted"
                  numberOfLines={1}
                  adjustsFontSizeToFit
                  maxFontSizeMultiplier={TICK_CAP}
                >
                  {yFormat(t)}
                </Text>
              </View>
            ))}
          </View>
        </View>
        <View style={[noTouch, { height: tickLine, marginTop: 4, marginEnd: GUTTER }]}>
          {plot > 0
            ? dayTicks.map((day, i) => {
                // Evenly spaced day ticks pin the first and last to the edges. Period ticks sit under their own
                // points, which need not be the domain's ends (the last month keyed Sep 1 in a range to Sep 29):
                // centred there, or aligned to an edge when a centred label would cross it.
                const at = x(day) - 32;
                const edge = periodic
                  ? at < 0
                    ? "start"
                    : at + 64 > plot
                      ? "end"
                      : "middle"
                  : dayTicks.length === 1
                    ? "middle"
                    : i === 0
                      ? "start"
                      : i === dayTicks.length - 1
                        ? "end"
                        : "middle";
                const place: ViewStyle =
                  edge === "start"
                    ? { position: "absolute", start: 0, maxWidth: plot / 2 }
                    : edge === "end"
                      ? { position: "absolute", end: 0, maxWidth: plot / 2 }
                      : { position: "absolute", start: at, width: 64 };
                return (
                  <View key={day} style={place}>
                    <Text
                      variant="readoutXS"
                      tone="muted"
                      numberOfLines={1}
                      maxFontSizeMultiplier={TICK_CAP}
                      className={
                        edge === "end"
                          ? "text-right"
                          : edge === "middle"
                            ? "text-center"
                            : undefined
                      }
                    >
                      {dayLabel(day)}
                    </Text>
                  </View>
                );
              })
            : null}
        </View>
      </View>
      {legend.length > 1 ? <Legend items={legend} /> : null}
    </View>
  );
}

export type SparklineProps = {
  points: ChartPoint[];
  /** Default 32. */
  height?: number;
  band?: ChartBandPoint[];
  minSpan?: number;
  /** Start at zero (water BAC). */
  zero?: boolean;
  /** A fixed window (water BAC: six hours ago … now); default: the points' own first and last. */
  from?: string;
  to?: string;
};

/**
 * A small trend in a row or tile: the 2pt tint line and a solid latest point, no axes. Hidden from screen
 * readers: the Value beside it is the readout. Mirrored under RTL; never stretched (no preserveAspectRatio).
 */
export function Sparkline({
  points,
  height = 32,
  band,
  minSpan = 0,
  zero = false,
  from,
  to,
}: SparklineProps) {
  const { isRTL } = useKit();
  const color = useChartColors();
  const [width, setWidth] = useState(0);
  const domain = extent(points.map((p) => p.day));
  const start = from ?? domain?.[0] ?? "";
  const end = to ?? domain?.[1] ?? start;
  const shown = points.filter((p) => p.day >= start && p.day <= end);
  const shownBand = (band ?? []).filter((p) => p.day >= start && p.day <= end);
  const values = [...shown.map((p) => p.value), ...shownBand.flatMap((p) => [p.low, p.high])];
  const scale = values.length ? chartScale(values, minSpan, zero) : { min: 0, max: 1 };
  const span = daysBetween(start, end);
  const pad = 4;
  const x = (day: string) =>
    pad + (span > 0 ? daysBetween(start, day) / span : 0.5) * Math.max(width - pad * 2, 0);
  const y = (value: number) =>
    pad + ((scale.max - value) / (scale.max - scale.min)) * (height - pad * 2);
  const latest = latestOf(shown);
  return (
    <View
      style={{ height }}
      onLayout={(e) => setWidth(Math.round(e.nativeEvent.layout.width))}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      {...webHidden}
    >
      {width > 0 ? (
        <View style={isRTL ? [noTouch, { transform: [{ scaleX: -1 }] }] : noTouch}>
          <Svg width={width} height={height}>
            {!shown.length ? (
              <Line
                x1={0}
                x2={width}
                y1={height / 2}
                y2={height / 2}
                stroke={color.grid}
                strokeWidth={2}
                strokeDasharray="4 3"
              />
            ) : null}
            {shownBand.length > 1 ? (
              <Path
                d={area(
                  shownBand.map((p) => ({ x: x(p.day), y: y(p.high) })),
                  shownBand.map((p) => ({ x: x(p.day), y: y(p.low) }))
                )}
                fill={color.subject}
                fillOpacity={0.1}
              />
            ) : null}
            {shown.length > 1 ? (
              <Path
                d={path(shown.map((p) => ({ x: x(p.day), y: y(p.value) })))}
                stroke={color.subject}
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                fill="none"
              />
            ) : null}
            {latest ? (
              <Circle cx={x(latest.day)} cy={y(latest.value)} r={3.5} fill={color.subject} />
            ) : null}
          </Svg>
        </View>
      ) : null}
    </View>
  );
}

/** Screen-reader names for the range codes ("3 months", "3 Monate"); the codes are the visible labels. */
function rangeNames(tag: string, all: string): Record<Range, string> {
  // Trusted as format.ts trusts unit output: Hermes on iOS formats units through NSMeasurementFormatter, which
  // may convert them (3 months as "13 weeks"). A name must hold the plain number and no other digit, else the
  // code is read. Checked from the output rather than intlSupport, so chart.tsx keeps its imports.
  const long = (n: number, unit: string) => {
    try {
      const name = new Intl.NumberFormat(tag, { style: "unit", unit, unitDisplay: "long" }).format(n);
      const plain = new Intl.NumberFormat(tag).format(n);
      return name.includes(plain) && !/[0-9٠-٩۰-۹]/.test(name.replace(plain, "")) ? name : null;
    } catch {
      return null;
    }
  };
  return Object.fromEntries(
    ranges.map((r) => {
      if (r === "All") return [r, all];
      const [n, unit] = rangeUnit[r];
      return [r, long(n, unit) ?? r];
    })
  ) as Record<Range, string>;
}

/**
 * Chart range chips: `Choices size="sm" mono` (36pt + hitSlop 4, the one allowed exception to 44). The codes
 * 1W…1Y read the same in every language, like a unit; screen readers get the Intl long form ("3 months"), or
 * the code where the engine's unit output is untrusted.
 */
export function RangeChips({
  value,
  onChange,
  accessibilityLabel,
  available = ranges,
}: {
  value: Range;
  onChange: (range: Range) => void;
  accessibilityLabel: string;
  /** Ranges worth offering, e.g. without 1Y for a new user. Default: all six. */
  available?: readonly Range[];
}) {
  const { tag } = useKitFormat();
  const strings = useKitStrings();
  const names = useMemo(() => rangeNames(tag, strings.all), [tag, strings.all]);
  return (
    <Choices
      values={available}
      value={value}
      onChange={onChange}
      label={(r) => (r === "All" ? strings.all : r)}
      optionLabel={(r) => names[r]}
      accessibilityLabel={accessibilityLabel}
      size="sm"
      mono
    />
  );
}

/**
 * The readout above a chart: the range's (or the scrubbed point's) value as a Value, an optional signed delta
 * and meta facets. A polite live region, so scrubbing is announced without interrupting.
 */
export function RangeSummary({
  label,
  value,
  unit,
  unitFirst,
  space,
  delta,
  meta,
}: {
  /** Eyebrow: what the value is ("TREND", or the scrubbed date). */
  label: string;
  /** Formatted: format.number / unitParts(...).value. */
  value: string;
  unit?: string;
  unitFirst?: boolean;
  /** unitParts(...).space: the locale's value–unit spacing. */
  space?: string;
  /** Formatted with a sign (format.number(n, d, true)); shown with the same unit. */
  delta?: string;
  /** Facets such as the date range or a session count, drawn with Meta. */
  meta?: string[];
}) {
  return (
    <View accessible accessibilityLiveRegion="polite" className="gap-1">
      <Label>{label}</Label>
      <View className="flex-row flex-wrap items-baseline gap-x-3">
        <Value value={value} unit={unit} unitFirst={unitFirst} space={space} size="l" />
        {delta ? (
          <Value
            value={delta}
            unit={unit}
            unitFirst={unitFirst}
            space={space}
            size="s"
            tone="secondary"
          />
        ) : null}
      </View>
      {meta?.length ? <Meta items={meta} /> : null}
    </View>
  );
}

/** line / dashed / dots draw the series mark; cat-1…3 are the P · C · F ink ramp; band and marker as drawn. */
export type LegendStyle =
  "line" | "dashed" | "dots" | "cat-1" | "cat-2" | "cat-3" | "band" | "marker";
export type LegendItem = {
  label: string;
  style: LegendStyle;
  /** Colour of a line / dashed / dots mark. Default: subject for line, reference for dashed and dots. */
  role?: "subject" | "reference";
};

const seriesFill = { subject: "bg-tint", reference: "bg-muted" } as const;
const catFill = { "cat-1": "bg-cat-1", "cat-2": "bg-cat-2", "cat-3": "bg-cat-3" } as const;

/** The legend mark: 8pt tall like the category square, drawn the way the series is drawn. */
function Swatch({ style, role }: { style: LegendStyle; role: "subject" | "reference" }) {
  switch (style) {
    case "line":
      return (
        <View className="h-2 w-4 justify-center">
          <View className={twMerge("h-0.5 rounded-mark", seriesFill[role])} />
        </View>
      );
    case "dashed":
      return (
        <View className="h-2 w-4 flex-row items-center gap-1">
          <View className={twMerge("h-0.5 flex-1", seriesFill[role])} />
          <View className={twMerge("h-0.5 flex-1", seriesFill[role])} />
        </View>
      );
    case "dots":
      return (
        <View className="h-2 w-4 items-center justify-center">
          <View
            className={twMerge(
              "size-[5px] rounded-full",
              role === "subject" ? "border border-tint bg-surface" : "bg-muted"
            )}
          />
        </View>
      );
    case "band":
      return <View className="h-2 w-4 rounded-mark bg-tint opacity-10" />;
    case "marker":
      return <View className="size-2 rounded-mark border-2 border-foreground bg-surface" />;
    default:
      return <View className={twMerge("size-2 rounded-mark", catFill[style])} />;
  }
}

/** Required for more than one series: a swatch plus a `small` muted label per entry, from the start edge. */
export function Legend({ items }: { items: LegendItem[] }) {
  return (
    <View className="flex-row flex-wrap gap-x-4 gap-y-2" accessibilityRole="list">
      {items.map((item) => (
        <View key={`${item.style}:${item.label}`} className="shrink flex-row items-center gap-2">
          <Swatch
            style={item.style}
            role={item.role ?? (item.style === "line" ? "subject" : "reference")}
          />
          {/* shrink (here and on the item): a long label wraps beside its swatch instead of overflowing. */}
          <Text variant="small" tone="muted" className="shrink">
            {item.label}
          </Text>
        </View>
      ))}
    </View>
  );
}
