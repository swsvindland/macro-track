import { useState, type ReactNode } from "react";
import { View, type GestureResponderEvent } from "react-native";
import Svg, { Circle, Line, Path, Rect } from "react-native-svg";
import { useThemeColor } from "heroui-native";
import { Segment } from "heroui-native-pro";
import { SystemLabel, SystemText as Text } from "@/components/system";
import { shortDay } from "@/lib/metrics";
import { useStore } from "@/lib/store";

const DAY = 86400000;
export const daysBetween = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / DAY;
const addDays = (day: string, days: number) =>
  new Date(Date.parse(day) + days * DAY).toISOString().slice(0, 10);

export const ranges = ["1W", "1M", "3M", "6M", "1Y", "All"] as const;
export type Range = (typeof ranges)[number];
const rangeDays = { "1W": 7, "1M": 30, "3M": 91, "6M": 182, "1Y": 365 };
const rangeNames = {
  "1W": "1 week",
  "1M": "1 month",
  "3M": "3 months",
  "6M": "6 months",
  "1Y": "1 year",
  All: "All time",
};
/** The first day a range shows up to `to`, never before the first day with data. */
export function rangeStart(range: Range, to: string, first: string) {
  const start = range === "All" ? first : addDays(to, 1 - rangeDays[range]);
  return start > first ? (start < to ? start : to) : first < to ? first : to;
}

export function RangeChips({
  value,
  onChange,
}: {
  value: Range;
  onChange: (range: Range) => void;
}) {
  return (
    <Segment
      value={value}
      size="sm"
      onValueChange={(next) => {
        const range = ranges.find((option) => option === next);
        if (range) onChange(range);
      }}
    >
      <Segment.Group className="self-stretch">
        <Segment.Indicator />
        {ranges.map((range) => (
          <Segment.Item
            key={range}
            value={range}
            className="flex-1"
            accessibilityLabel={rangeNames[range]}
          >
            <Segment.Label>{range}</Segment.Label>
          </Segment.Item>
        ))}
      </Segment.Group>
    </Segment>
  );
}

/** Evenly spaced round values across a scale. */
function ticks(min: number, max: number) {
  const raw = (max - min) / 4,
    power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((factor) => factor * power).find((value) => value >= raw)!;
  const values: number[] = [];
  for (let value = Math.ceil(min / step) * step; value <= max; value += step)
    values.push(Math.round(value / step) * step);
  return values;
}
/** A scale over the values, at least `minSpan` tall and padded so lines clear the edges. */
function scale(values: number[], minSpan: number) {
  let min = Math.min(...values),
    max = Math.max(...values);
  if (max - min < minSpan) {
    const middle = (min + max) / 2;
    min = middle - minSpan / 2;
    max = middle + minSpan / 2;
  }
  const pad = (max - min) * 0.08;
  return { min: min - pad, max: max + pad };
}
const line = (points: { x: number; y: number }[]) =>
  points.map((point, i) => `${i ? "L" : "M"}${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join("");

export type ChartPoint = { day: string; value: number };
export type ChartLine = {
  key: string;
  /** Runs drawn as separate paths, so a style can change mid-series. */
  segments: ChartPoint[][];
  color: string;
  width?: number;
  dots?: boolean;
  dashed?: boolean;
  opacity?: number;
};
const Y_AXIS = 48;

/**
 * A dated line chart: optional shaded range, goal line and markers, labels on the right, and a
 * press-and-drag readout reported through `onScrub`.
 */
export function TrendChart({
  from,
  to,
  lines,
  band,
  goal,
  markers,
  minSpan,
  format,
  label,
  scrub,
  onScrub,
  height = 220,
}: {
  from: string;
  to: string;
  lines: ChartLine[];
  band?: { points: { day: string; low: number; high: number }[]; color: string };
  goal?: { value: number; label: string };
  markers?: { points: ChartPoint[]; color: string };
  minSpan: number;
  format: (value: number) => string;
  label: string;
  scrub?: string | null;
  onScrub?: (day: string | null) => void;
  height?: number;
}) {
  const { language } = useStore();
  const [width, setWidth] = useState(0);
  const [separator, muted, surface, success] = useThemeColor([
    "separator",
    "muted",
    "surface",
    "success",
  ]);
  const shown = <T extends { day: string }>(points: T[]) =>
    points.filter((point) => point.day >= from && point.day <= to);
  const drawn = lines.map((item) => ({ ...item, segments: item.segments.map(shown) }));
  const ranged = band ? shown(band.points) : [];
  const marked = markers ? shown(markers.points) : [];
  const values = [
    ...drawn.flatMap((item) => item.segments.flat().map((point) => point.value)),
    ...ranged.flatMap((point) => [point.low, point.high]),
    ...marked.map((point) => point.value),
  ];
  if (!values.length) return null;
  const data = scale(values, minSpan);
  // A goal far outside the data is labelled at the edge instead of flattening the lines.
  const near =
    goal &&
    goal.value >= data.min - (data.max - data.min) &&
    goal.value <= data.max + (data.max - data.min);
  const { min, max } = near ? scale([...values, goal.value], minSpan) : data;
  const plot = Math.max(width - Y_AXIS, 1),
    span = daysBetween(from, to),
    top = 10,
    bottom = height - 10;
  const x = (day: string) => (span > 0 ? (daysBetween(from, day) / span) * plot : plot / 2);
  const y = (value: number) => top + ((max - value) / (max - min)) * (bottom - top);
  const points = (segment: ChartPoint[]) =>
    segment.map((point) => ({ x: x(point.day), y: y(point.value) }));
  const move = (event: GestureResponderEvent) => {
    const position = Math.min(Math.max(event.nativeEvent.locationX, 0), plot);
    onScrub?.(addDays(from, Math.round((position / plot) * span)));
  };
  const nearest = (segments: ChartPoint[][]) =>
    scrub
      ? segments
          .flat()
          .reduce<ChartPoint | null>(
            (best, point) =>
              !best ||
              Math.abs(daysBetween(point.day, scrub)) < Math.abs(daysBetween(best.day, scrub))
                ? point
                : best,
            null
          )
      : null;
  const dateTicks =
    span > 0 ? [0, 1, 2, 3].map((i) => addDays(from, Math.round((span * i) / 3))) : [from];
  const dateLabel = (day: string) =>
    span <= 120
      ? shortDay(day, language)
      : new Date(`${day}T12:00:00`).toLocaleDateString(language === "zh" ? "zh-CN" : language, {
          month: "short",
          ...(span > 400 ? { year: "2-digit" as const } : {}),
        });
  return (
    <View className="gap-1">
      <View
        style={{ height }}
        onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
        onStartShouldSetResponder={() => !!onScrub}
        onResponderGrant={move}
        onResponderMove={move}
        onResponderRelease={() => onScrub?.(null)}
        onResponderTerminate={() => onScrub?.(null)}
      >
        {width > 0 && (
          <Svg
            width={plot}
            height={height}
            accessible
            accessibilityRole="image"
            accessibilityLabel={label}
          >
            {ticks(min, max).map((value) => (
              <Line
                key={value}
                x1={0}
                x2={plot}
                y1={y(value)}
                y2={y(value)}
                stroke={separator}
                strokeWidth={1}
              />
            ))}
            {ranged.length > 1 && band && (
              <Path
                d={`${line(ranged.map((point) => ({ x: x(point.day), y: y(point.high) })))}${line(
                  [...ranged].reverse().map((point) => ({ x: x(point.day), y: y(point.low) }))
                ).replace("M", "L")}Z`}
                fill={band.color}
                opacity={0.2}
              />
            )}
            {goal && near && (
              <Line
                x1={0}
                x2={plot}
                y1={y(goal.value)}
                y2={y(goal.value)}
                stroke={success}
                strokeWidth={1.5}
                strokeDasharray="6 4"
              />
            )}
            {drawn.map((item) =>
              item.segments.map((segment, i) =>
                segment.length > 1 ? (
                  <Path
                    key={`${item.key}-${i}`}
                    d={line(points(segment))}
                    stroke={item.color}
                    strokeWidth={item.width ?? 2}
                    strokeDasharray={item.dashed ? "4 4" : undefined}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    opacity={item.opacity}
                    fill="none"
                  />
                ) : null
              )
            )}
            {drawn.map((item) => {
              const all = item.segments.flat();
              return item.dots || all.length === 1
                ? all.length <= 62 &&
                    all.map((point) => (
                      <Circle
                        key={`${item.key}-${point.day}`}
                        cx={x(point.day)}
                        cy={y(point.value)}
                        r={3}
                        fill={surface}
                        stroke={item.color}
                        strokeWidth={1.5}
                      />
                    ))
                : null;
            })}
            {markers &&
              marked.map((point) => (
                <Rect
                  key={point.day}
                  x={x(point.day) - 4}
                  y={y(point.value) - 4}
                  width={8}
                  height={8}
                  rx={2}
                  fill={surface}
                  stroke={markers.color}
                  strokeWidth={2}
                />
              ))}
            {scrub && (
              <Line
                x1={x(scrub)}
                x2={x(scrub)}
                y1={top}
                y2={bottom}
                stroke={muted}
                strokeWidth={1}
              />
            )}
            {drawn.map((item) => {
              const point = nearest(item.segments);
              return point ? (
                <Circle
                  key={`${item.key}-scrub`}
                  cx={x(point.day)}
                  cy={y(point.value)}
                  r={4.5}
                  fill={item.color}
                  stroke={surface}
                  strokeWidth={2}
                />
              ) : null;
            })}
          </Svg>
        )}
        {width > 0 &&
          ticks(min, max).map((value) => (
            <Text
              key={value}
              className="absolute font-mono text-xs text-muted"
              style={{ right: 0, top: y(value) - 8, width: Y_AXIS - 6 }}
              maxFontSizeMultiplier={1.2}
            >
              {format(value)}
            </Text>
          ))}
        {width > 0 && goal && !near && (
          <Text
            className="absolute text-xs font-medium text-success"
            style={{ left: 0, [goal.value < min ? "bottom" : "top"]: 0 }}
          >
            {goal.value < min ? "↓" : "↑"} {goal.label}
          </Text>
        )}
        {width > 0 && goal && near && (
          <Text
            className="absolute text-xs font-medium text-success"
            style={{ left: 4, top: y(goal.value) + (y(goal.value) > height - 30 ? -18 : 3) }}
          >
            {goal.label}
          </Text>
        )}
      </View>
      <View style={{ height: 16, marginRight: Y_AXIS }}>
        {width > 0 &&
          dateTicks.map((day, i) => (
            <Text
              key={day}
              className="absolute font-mono text-xs text-muted"
              maxFontSizeMultiplier={1.2}
              style={
                i === 0
                  ? { left: 0 }
                  : i === dateTicks.length - 1
                    ? { right: 0, textAlign: "right" }
                    : { left: x(day) - 32, width: 64, textAlign: "center" }
              }
            >
              {dateLabel(day)}
            </Text>
          ))}
      </View>
    </View>
  );
}

/** A small line of recent days for an insight card. */
export function Sparkline({
  points,
  band,
  color,
  minSpan,
}: {
  points: ChartPoint[];
  band?: { day: string; low: number; high: number }[];
  color: string;
  minSpan: number;
}) {
  const [width, setWidth] = useState(0);
  const [surface, separator] = useThemeColor(["surface", "separator"]);
  const height = 44;
  const first = points[0]?.day ?? "",
    span = points.length > 1 ? daysBetween(first, points.at(-1)!.day) : 0;
  const values = [
    ...points.map((point) => point.value),
    ...(band ?? []).flatMap((p) => [p.low, p.high]),
  ];
  const { min, max } = values.length ? scale(values, minSpan) : { min: 0, max: 1 };
  const x = (day: string) => 5 + (span ? daysBetween(first, day) / span : 0.5) * (width - 10);
  const y = (value: number) => 5 + ((max - value) / (max - min)) * (height - 10);
  return (
    <View
      style={{ height }}
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
    >
      {width > 0 && (
        <Svg width={width} height={height}>
          {!points.length && (
            <Line
              x1={0}
              x2={width}
              y1={height / 2}
              y2={height / 2}
              stroke={separator}
              strokeWidth={2}
              strokeDasharray="4 4"
            />
          )}
          {band && band.length > 1 && (
            <Path
              d={`${line(band.map((p) => ({ x: x(p.day), y: y(p.high) })))}${line(
                [...band].reverse().map((p) => ({ x: x(p.day), y: y(p.low) }))
              ).replace("M", "L")}Z`}
              fill={color}
              opacity={0.2}
            />
          )}
          {points.length > 1 && (
            <Path
              d={line(points.map((p) => ({ x: x(p.day), y: y(p.value) })))}
              stroke={color}
              strokeWidth={2}
              strokeLinejoin="round"
              fill="none"
            />
          )}
          {points.map((point) => (
            <Circle
              key={point.day}
              cx={x(point.day)}
              cy={y(point.value)}
              r={3}
              fill={surface}
              stroke={color}
              strokeWidth={1.5}
            />
          ))}
        </Svg>
      )}
    </View>
  );
}

/** Average and difference over a range, or the scrubbed day's reading in their place. */
export function RangeSummary({
  stats,
  caption,
}: {
  stats: { label: string; value: string; unit: string }[];
  caption: string;
}) {
  return (
    <View className="gap-1" accessibilityLiveRegion="polite">
      <View className="flex-row gap-6">
        {stats.map((stat) => (
          <View key={stat.label} className="gap-0.5">
            <SystemLabel>{stat.label}</SystemLabel>
            <Text className="text-3xl font-semibold tabular-nums" maxFontSizeMultiplier={1.3}>
              {stat.value}
              <Text className="text-base font-medium text-muted"> {stat.unit}</Text>
            </Text>
          </View>
        ))}
      </View>
      <Text className="text-sm text-muted tabular-nums">{caption}</Text>
    </View>
  );
}

export function Legend({ items }: { items: { label: string; swatch: ReactNode }[] }) {
  return (
    <View className="flex-row flex-wrap justify-center gap-x-5 gap-y-2">
      {items.map((item) => (
        <View key={item.label} className="flex-row items-center gap-2">
          {item.swatch}
          <Text className="text-sm text-muted">{item.label}</Text>
        </View>
      ))}
    </View>
  );
}
