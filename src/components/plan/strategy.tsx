import type { ReactNode } from "react";
import { Pressable, View } from "react-native";
import Svg, { Circle } from "react-native-svg";
import { useThemeColor } from "heroui-native";
import { twMerge } from "tailwind-merge";
import { names, short, useWeekOrder } from "@/components/plan/calorie-shift";
import {
  SystemIcon,
  SystemLabel,
  SystemPanel,
  SystemText as Text,
  type IconName,
} from "@/components/system";
import { shortDay } from "@/lib/metrics";
import type { Targets } from "@/lib/nutrition";
import { useStore } from "@/lib/store";

const RING = 184,
  GOAL_WIDTH = 5,
  WEEK_WIDTH = 7;
const outer = (RING - GOAL_WIDTH) / 2,
  inner = outer - GOAL_WIDTH / 2 - 6 - WEEK_WIDTH / 2;

/** One arc over its track, clockwise from the top once the ring is turned. */
function Arc({
  radius,
  width,
  value,
  color,
  track,
}: {
  radius: number;
  width: number;
  value: number;
  color: string;
  track: string;
}) {
  const length = 2 * Math.PI * radius,
    shown = Math.min(Math.max(value, 0), 1);
  return (
    <>
      <Circle
        cx={RING / 2}
        cy={RING / 2}
        r={radius}
        stroke={track}
        strokeWidth={width}
        fill="none"
      />
      {shown > 0 && (
        <Circle
          cx={RING / 2}
          cy={RING / 2}
          r={radius}
          stroke={color}
          strokeWidth={width}
          strokeLinecap="round"
          strokeDasharray={`${length * shown} ${length}`}
          fill="none"
        />
      )}
    </>
  );
}

function Legend({
  icon,
  color,
  label,
  value,
}: {
  icon: IconName;
  color: "success" | "foreground";
  label: string;
  value: string;
}) {
  return (
    <View className="flex-row items-center gap-1.5">
      <SystemIcon name={icon} size={18} color={color} />
      <Text className="text-sm" maxFontSizeMultiplier={1.3}>
        {label}
      </Text>
      <Text className="text-sm text-muted tabular-nums" maxFontSizeMultiplier={1.3}>
        {value}
      </Text>
    </View>
  );
}

/**
 * The countdown to the next check-in: the inner arc fills as its week passes, and the outer one
 * shows how far the trend has come toward the goal weight.
 */
export function CheckInRing({
  days,
  progress,
  goal,
  due,
}: {
  /** Days until the check-in: 0 on the day, negative once it's overdue. */
  days: number;
  /** The share of the check-in's cycle that has passed. */
  progress: number;
  /** The share of the way to the goal weight, or null without a distance to cover. */
  goal: number | null;
  due: string;
}) {
  const { number, language } = useStore();
  const [track, week, reached] = useThemeColor(["surface-secondary", "foreground", "success"]);
  const weekday = (format: "short" | "long") =>
    new Date(`${due}T12:00:00`).toLocaleDateString(language === "zh" ? "zh-CN" : language, {
      weekday: format,
    });
  const count = `${number(days, 0)} ${days === 1 ? "day" : "days"}`;
  const percent = goal === null ? null : `${number(goal * 100, 0)}%`;
  const label = [
    days > 0
      ? `${count} until check-in on ${weekday("long")}`
      : days === 0
        ? "Check-in today"
        : `Check-in due since ${weekday("long")}`,
    ...(percent ? [`${percent} of the way to your goal weight`] : []),
  ].join(". ");
  return (
    <View accessible accessibilityLabel={label} className="items-center gap-3 py-2">
      <View className="items-center justify-center" style={{ width: RING, height: RING }}>
        <Svg
          width={RING}
          height={RING}
          style={{ position: "absolute", transform: [{ rotate: "-90deg" }] }}
        >
          {goal !== null && (
            <Arc radius={outer} width={GOAL_WIDTH} value={goal} color={reached} track={track} />
          )}
          <Arc radius={inner} width={WEEK_WIDTH} value={progress} color={week} track={track} />
        </Svg>
        <View className="items-center" style={{ width: inner * 2 - 32 }}>
          {days > 0 ? (
            <>
              <Text
                className="text-4xl font-semibold tabular-nums"
                numberOfLines={1}
                adjustsFontSizeToFit
                maxFontSizeMultiplier={1.2}
              >
                {count}
              </Text>
              <Text className="text-sm text-muted" maxFontSizeMultiplier={1.2}>
                until check-in
              </Text>
            </>
          ) : (
            <>
              <Text className="text-sm text-muted" maxFontSizeMultiplier={1.2}>
                Check-in
              </Text>
              <Text
                className="text-4xl font-semibold"
                numberOfLines={1}
                adjustsFontSizeToFit
                maxFontSizeMultiplier={1.2}
              >
                {days === 0 ? "Today" : "Due"}
              </Text>
            </>
          )}
        </View>
      </View>
      <View className="flex-row flex-wrap justify-center gap-x-5 gap-y-1">
        {percent && <Legend icon="radio-button-on" color="success" label="Goal" value={percent} />}
        <Legend
          icon="calendar-outline"
          color="foreground"
          label="Check-in"
          value={weekday("short")}
        />
      </View>
    </View>
  );
}

const COLUMN = 150,
  GAP = 2;
const parts = [
  { key: "protein", unit: "P", kcal: 4, fill: "bg-chart-protein" },
  { key: "fat", unit: "F", kcal: 9, fill: "bg-chart-fat" },
  { key: "carbs", unit: "C", kcal: 4, fill: "bg-chart-carbs" },
] as const;

/** The week for screen readers: days with the same targets together, in the week's order. */
function describeWeek(
  week: Targets[],
  order: number[],
  number: (value: number, digits?: number) => string
) {
  const groups: { days: number[]; targets: Targets }[] = [];
  for (const weekday of order) {
    const targets = week[weekday];
    const same = groups.find((group) =>
      (["calories", "protein", "fat", "carbs"] as const).every(
        (key) => group.targets[key] === targets[key]
      )
    );
    if (same) same.days.push(weekday);
    else groups.push({ days: [weekday], targets });
  }
  const amounts = ({ calories, protein, fat, carbs }: Targets) =>
    `${number(calories, 0)} kcal, ${number(protein, 0)} g protein, ${number(fat, 0)} g fat, ${number(carbs, 0)} g carbs`;
  return groups.length === 1
    ? `Every day ${amounts(groups[0].targets)}`
    : groups
        .map(
          (group) => `${group.days.map((day) => names[day]).join(", ")}: ${amounts(group.targets)}`
        )
        .join(". ");
}

/**
 * Each weekday's targets as a column: calories on top, then protein, fat and carbs in grams, each
 * as tall as its share of the calories. Columns share one scale, so higher days stand taller.
 */
export function ProgramWeek({ week, today }: { week: Targets[]; today: number }) {
  const { number } = useStore();
  const order = useWeekOrder();
  const most = Math.max(...week.map((day) => day.calories), 1);
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={describeWeek(week, order, number)}
      className="flex-row items-end gap-1.5"
    >
      {order.map((weekday) => {
        const targets = week[weekday];
        const shown = parts.filter((part) => targets[part.key] > 0);
        const energy = shown.reduce((sum, part) => sum + targets[part.key] * part.kcal, 0);
        const height = (COLUMN * Math.max(targets.calories, 0)) / most;
        const room = Math.max(height - GAP * (shown.length - 1), 0);
        return (
          <View key={weekday} className="min-w-0 flex-1 items-center gap-1">
            <View className="max-w-full rounded-full bg-chart-calories px-1.5 py-0.5">
              <Text
                className="text-xs font-semibold text-background tabular-nums"
                numberOfLines={1}
                adjustsFontSizeToFit
                maxFontSizeMultiplier={1.2}
              >
                {number(targets.calories, 0)}
              </Text>
            </View>
            <View className="w-full" style={{ height, gap: GAP }}>
              {shown.map((part) => {
                const size = energy > 0 ? (room * targets[part.key] * part.kcal) / energy : 0;
                return (
                  <View
                    key={part.key}
                    className={`items-center justify-center overflow-hidden rounded-[6px] ${part.fill}`}
                    style={{ height: size }}
                  >
                    {size >= 16 && (
                      <Text
                        className="text-xs font-medium text-background tabular-nums"
                        numberOfLines={1}
                        adjustsFontSizeToFit
                        maxFontSizeMultiplier={1.2}
                      >
                        {`${number(targets[part.key], 0)} ${part.unit}`}
                      </Text>
                    )}
                  </View>
                );
              })}
            </View>
            <Text
              className={twMerge(
                "text-xs",
                weekday === today ? "font-semibold text-foreground" : "text-muted"
              )}
              maxFontSizeMultiplier={1.2}
            >
              {short[weekday]}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

/**
 * The running program: its name, when it began and its week. With `onPress` the whole card
 * opens the program; `action` sits in its corner outside that button, so screen readers reach
 * both.
 */
export function ProgramCard({
  name,
  since,
  detail,
  week,
  today,
  notes = [],
  onPress,
  action,
  children,
}: {
  name: string;
  /** The day the program began. */
  since: string | null;
  /** Follows the dates, such as the goal and its pace. */
  detail?: string;
  /** Each weekday's targets, Sunday first. */
  week: Targets[] | null;
  /** Today's weekday, 0 for Sunday. */
  today: number;
  /** Short lines under the week, read with the card. */
  notes?: string[];
  onPress?: () => void;
  action?: ReactNode;
  children?: ReactNode;
}) {
  const { number, language } = useStore();
  const order = useWeekOrder();
  const subtitle = [since ? `${shortDay(since, language)} – now` : "", detail ?? ""]
    .filter(Boolean)
    .join(" · ");
  const panel = (pressed = false) => (
    <SystemPanel className={twMerge("p-4", pressed && "opacity-70")}>
      <SystemPanel.Body className="gap-3">
        <SystemLabel className={action ? "pr-10" : undefined}>In progress</SystemLabel>
        <View className="gap-0.5">
          <View className="flex-row items-center gap-1">
            <Text accessibilityRole="header" className="shrink text-xl font-semibold">
              {name}
            </Text>
            {onPress && <SystemIcon name="chevron-forward" size={18} color="muted" />}
          </View>
          {!!subtitle && <Text className="text-sm text-muted tabular-nums">{subtitle}</Text>}
        </View>
        {week && <ProgramWeek week={week} today={today} />}
        {notes.map((note) => (
          <Text key={note} className="text-sm text-muted">
            {note}
          </Text>
        ))}
        {children}
      </SystemPanel.Body>
    </SystemPanel>
  );
  return (
    <View>
      {onPress ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={[
            name,
            subtitle,
            week ? describeWeek(week, order, number) : "",
            ...notes,
          ]
            .filter(Boolean)
            .join(". ")}
          accessibilityHint="Edits your program"
          onPress={onPress}
        >
          {({ pressed }) => panel(pressed)}
        </Pressable>
      ) : (
        panel()
      )}
      {action && <View className="absolute right-1 top-1">{action}</View>}
    </View>
  );
}
