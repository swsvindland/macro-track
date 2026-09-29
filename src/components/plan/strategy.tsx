import type { ReactNode } from "react";
import { View } from "react-native";
import Svg, { Circle } from "react-native-svg";
import { useThemeColor } from "heroui-native";
import { twMerge } from "tailwind-merge";
import { useWeekOrder, weekdayName } from "@/components/plan/calorie-shift";
import {
  Heading,
  Icon,
  Label,
  Legend,
  Meta,
  Note,
  Panel,
  Text,
  Value,
  useKitFormat,
  useKitStrings,
  type Format,
} from "@/vector";
import { shortDay } from "@/lib/metrics";
import type { Targets } from "@/lib/nutrition";
import { useStore } from "@/lib/store";
import type { Message } from "@/lib/translations";

const RING = 184,
  GOAL_WIDTH = 5,
  WEEK_WIDTH = 7;
const outer = (RING - GOAL_WIDTH) / 2,
  inner = outer - GOAL_WIDTH / 2 - 6 - WEEK_WIDTH / 2;

/** One arc over its track, clockwise from the top once the ring is turned (a clock never mirrors). */
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
          strokeLinecap="butt"
          strokeDasharray={`${length * shown} ${length}`}
          fill="none"
        />
      )}
    </>
  );
}

/** A ring's key: the arc's mark, what it measures and its readout. */
function Key({ mark, label, value }: { mark: string; label: string; value: string }) {
  return (
    <View className="flex-row items-center gap-2">
      <View className={twMerge("h-2 w-4 rounded-mark", mark)} />
      <Text variant="small" className="shrink">
        {label}
      </Text>
      <Text variant="readoutXS" tone="muted">
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
  const { t } = useStore();
  const format = useKitFormat();
  const strings = useKitStrings();
  const [track, week, reached] = useThemeColor(["surface-tertiary", "foreground", "link"]);
  const weekday = (style: "short" | "long") => {
    const day = new Date(`${due}T12:00:00`);
    return style === "long" ? format.weekdayLong(day) : format.weekdayShort(day);
  };
  const one = format.plural(days) === "one";
  const percent = goal === null ? null : format.percent(goal);
  const label = sentences(
    [
      days > 0
        ? t("checkInCountdown", {
            days: t(one ? "dayCountOne" : "dayCount", { count: format.number(days) }),
            day: weekday("long"),
          })
        : days === 0
          ? t("checkInToday")
          : t("checkInOverdue", { day: weekday("long") }),
      ...(percent ? [t("goalProgress", { percent })] : []),
    ],
    t
  );
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
        {/* A fixed slot inside the ring: one line that shrinks before it clips. */}
        <View className="items-center" style={{ width: inner * 2 - 32 }}>
          {days > 0 ? (
            <>
              <Value
                size="xl"
                value={format.number(days)}
                unit={t(one ? "dayUnitOne" : "dayUnit")}
                numberOfLines={1}
                adjustsFontSizeToFit
                maxFontSizeMultiplier={1.2}
              />
              <Note maxFontSizeMultiplier={1.2}>{t("untilCheckIn")}</Note>
            </>
          ) : (
            <>
              <Note maxFontSizeMultiplier={1.2}>{t("checkIn")}</Note>
              <Text variant="h1" numberOfLines={1} adjustsFontSizeToFit maxFontSizeMultiplier={1.2}>
                {t(days === 0 ? "today" : "due")}
              </Text>
            </>
          )}
        </View>
      </View>
      <View className="flex-row flex-wrap justify-center gap-x-5 gap-y-1">
        {percent && <Key mark="bg-tint" label={strings.goal} value={percent} />}
        <Key mark="bg-foreground" label={t("checkIn")} value={weekday("short")} />
      </View>
    </View>
  );
}

const COLUMN = 150,
  GAP = 2;
// P · C · F from the top, on the ink ramp.
const parts = [
  { key: "protein", name: "macroProtein", kcal: 4, fill: "bg-cat-1", legend: "cat-1" },
  { key: "carbs", name: "macroCarbs", kcal: 4, fill: "bg-cat-2", legend: "cat-2" },
  { key: "fat", name: "macroFat", kcal: 9, fill: "bg-cat-3", legend: "cat-3" },
] as const;

/** The week for screen readers: days with the same targets together, in the week's order. */
/** Spoken sentences in a row, with the script's spacing between them (none in Chinese or Japanese). */
const sentences = (
  parts: string[],
  t: (key: Message, values?: Record<string, string | number>) => string
) => parts.reduce((all, part) => t("joinSentences", { first: all, second: part }));

function describeWeek(
  week: Targets[],
  order: number[],
  format: Format,
  t: (key: Message, values?: Record<string, string | number>) => string
) {
  const groups: { days: number[]; targets: Targets }[] = [];
  for (const weekday of order) {
    const targets = week[weekday];
    const same = groups.find((group) =>
      (["calories", "protein", "carbs", "fat"] as const).every(
        (key) => group.targets[key] === targets[key]
      )
    );
    if (same) same.days.push(weekday);
    else groups.push({ days: [weekday], targets });
  }
  const amounts = ({ calories, protein, carbs, fat }: Targets) =>
    t("spokenMacros", {
      kcal: format.number(calories),
      protein: format.number(protein),
      carbs: format.number(carbs),
      fat: format.number(fat),
    });
  return groups.length === 1
    ? t("everyDayTargets", { targets: amounts(groups[0].targets) })
    : sentences(
        groups.map((group) =>
          t("daysTargets", {
            days: format.list(group.days.map((day) => weekdayName(format, day, "long"))),
            targets: amounts(group.targets),
          })
        ),
        t
      );
}

/**
 * Each weekday's targets as a column: calories on top, then protein, carbs and fat in grams, each
 * as tall as its share of the calories. Columns share one scale, so higher days stand taller. The
 * grams sit beside each bar on the surface, where they read in every theme.
 */
export function ProgramWeek({ week, today }: { week: Targets[]; today: number }) {
  const { t } = useStore();
  const format = useKitFormat();
  const order = useWeekOrder();
  const most = Math.max(...week.map((day) => day.calories), 1);
  return (
    <View className="gap-3">
      <View
        accessible
        accessibilityRole="image"
        accessibilityLabel={describeWeek(week, order, format, t)}
        className="flex-row items-end gap-1.5"
      >
        {order.map((weekday) => {
          const targets = week[weekday];
          const shown = parts.filter((part) => targets[part.key] > 0);
          const energy = shown.reduce((sum, part) => sum + targets[part.key] * part.kcal, 0);
          const height = (COLUMN * Math.max(targets.calories, 0)) / most;
          const room = Math.max(height - GAP * (shown.length - 1), 0);
          const size = (part: (typeof parts)[number]) =>
            energy > 0 ? (room * targets[part.key] * part.kcal) / energy : 0;
          return (
            <View key={weekday} className="min-w-0 flex-1 items-center gap-1">
              {/* Fixed column slots: one line that shrinks before it clips. */}
              <Text
                variant="readoutXS"
                tone="tint"
                numberOfLines={1}
                adjustsFontSizeToFit
                maxFontSizeMultiplier={1.2}
              >
                {format.number(targets.calories)}
              </Text>
              <View className="w-full flex-row gap-1" style={{ height }}>
                <View className="w-3" style={{ gap: GAP }}>
                  {shown.map((part) => (
                    <View
                      key={part.key}
                      className={`rounded-mark ${part.fill}`}
                      style={{ height: size(part) }}
                    />
                  ))}
                </View>
                <View className="min-w-0 flex-1" style={{ gap: GAP }}>
                  {shown.map((part) => (
                    <View key={part.key} className="justify-center" style={{ height: size(part) }}>
                      {size(part) >= 16 && (
                        <Text
                          variant="readoutXS"
                          tone="secondary"
                          numberOfLines={1}
                          adjustsFontSizeToFit
                          maxFontSizeMultiplier={1.2}
                        >
                          {format.number(targets[part.key])}
                        </Text>
                      )}
                    </View>
                  ))}
                </View>
              </View>
              <Text
                variant="caption"
                tone={weekday === today ? "default" : "muted"}
                maxFontSizeMultiplier={1.2}
              >
                {weekdayName(format, weekday, "short")}
              </Text>
            </View>
          );
        })}
      </View>
      {/* The chart's own label already names each macro for screen readers. */}
      <View importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
        <Legend items={parts.map((part) => ({ label: t(part.name), style: part.legend }))} />
      </View>
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
  /** Short lines under the week, read with the card; a list is one line of facets. */
  notes?: (string | string[])[];
  onPress?: () => void;
  action?: ReactNode;
  children?: ReactNode;
}) {
  const { t } = useStore();
  const format = useKitFormat();
  const order = useWeekOrder();
  const facets = [since ? t("sinceDay", { day: shortDay(since, format.tag) }) : "", detail ?? ""];
  const spoken = format.list([name, ...facets, ...notes.flat()].filter(Boolean));
  return (
    <View>
      <Panel
        onPress={onPress}
        // The card's words, then the week in sentences.
        accessibilityLabel={
          onPress
            ? week
              ? t("programCardSpoken", {
                  summary: spoken,
                  week: describeWeek(week, order, format, t),
                })
              : spoken
            : undefined
        }
        accessibilityHint={onPress ? t("editsYourProgram") : undefined}
      >
        <Panel.Body>
          <Label className={action ? "pe-10" : undefined}>{t("inProgress")}</Label>
          <View className="gap-0.5">
            <View className="flex-row items-center gap-1">
              <Heading level={3} className="shrink">
                {name}
              </Heading>
              {onPress && <Icon name="forward" size={17} tone="muted" />}
            </View>
            {facets.some(Boolean) && <Meta items={facets} />}
          </View>
          {week && <ProgramWeek week={week} today={today} />}
          {notes.map((note) =>
            Array.isArray(note) ? (
              <Meta key={note.join()} items={note} />
            ) : (
              <Note key={note}>{note}</Note>
            )
          )}
          {children}
        </Panel.Body>
      </Panel>
      {action && <View className="absolute end-1 top-1">{action}</View>}
    </View>
  );
}
