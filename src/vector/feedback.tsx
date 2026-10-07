import { Children, useEffect, useState, type ReactNode } from "react";
import { View, type LayoutChangeEvent } from "react-native";
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import { twMerge } from "tailwind-merge";
import { Button, LinkButton } from "./button";
import { duration, easing, useReducedMotionSafe } from "./motion";
import { useKit, useKitStrings, webA11y, webHidden } from "./provider";
import { Label, Text } from "./text";

const calloutTone = {
  info: { rule: "border-tint", title: "text-accent-soft-foreground" },
  success: { rule: "border-success", title: "text-success-soft-foreground" },
  warning: { rule: "border-warning", title: "text-warning-soft-foreground" },
  danger: { rule: "border-danger", title: "text-danger-soft-foreground" },
} as const;

/** Text runs (strings, numbers) need an RN Text around them; a bare string inside a View crashes. */
const hasText = (children: ReactNode) =>
  Children.toArray(children).some((c) => typeof c === "string" || typeof c === "number");

/**
 * A 2pt start rule in the tone colour on the white surface: no wash. Placed directly under the control that
 * caused it. Danger and warning interrupt (role alert); info and success are a polite live region. Children
 * with any text in them (`{"Limit"} {value}`) render as one `small` Text; elements alone render as given.
 */
export function Callout({
  tone,
  title,
  children,
}: {
  tone: "info" | "success" | "warning" | "danger";
  title?: string;
  children: ReactNode;
}) {
  const t = calloutTone[tone];
  const urgent = tone === "danger" || tone === "warning";
  return (
    <View
      accessible
      accessibilityRole={urgent ? "alert" : undefined}
      accessibilityLiveRegion={urgent ? "assertive" : "polite"}
      className={twMerge("gap-1 border-s-2 py-1 ps-3", t.rule)}
    >
      {title ? <Label className={t.title}>{title}</Label> : null}
      {hasText(children) ? <Text variant="small">{children}</Text> : children}
    </View>
  );
}

/** Callout danger with no title. Renders nothing for an empty message, so it can sit in place permanently. */
export function ErrorText({ message }: { message: string }) {
  return message ? <Callout tone="danger">{message}</Callout> : null;
}

const dot = {
  live: "bg-accent",
  ok: "bg-success",
  attention: "bg-warning",
  error: "bg-danger",
  idle: "border border-border-strong",
  off: "border border-muted",
} as const;

/** 6pt dot + a status word (Label style) + optional readoutXS meta. Never a pill, never pulses. */
export function Status({
  state,
  label,
  meta,
}: {
  state: "live" | "ok" | "attention" | "error" | "idle" | "off";
  label: string;
  meta?: string;
}) {
  return (
    // One element for VoiceOver: it reads the word and the meta together; the dot is decoration.
    <View accessible className="flex-row flex-wrap items-center gap-2">
      <View className={twMerge("size-1.5 rounded-full", dot[state])} />
      <Label>{label}</Label>
      {meta ? (
        <Text variant="readoutXS" tone="muted">
          {meta}
        </Text>
      ) : null}
    </View>
  );
}

const percent = (value: number, max: number) =>
  max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;

/** A width in % animated over `slow` on the standard curve; jumps under Reduce Motion. */
function useWidth(pct: number, reduceMotion: boolean) {
  const w = useSharedValue(pct);
  useEffect(() => {
    // .set/.get rather than .value: the React Compiler lint treats hook results as immutable.
    w.set(
      reduceMotion ? pct : withTiming(pct, { duration: duration.slow, easing: easing.standard })
    );
  }, [pct, reduceMotion, w]);
  return w;
}
const useWidthStyle = (w: SharedValue<number>) =>
  useAnimatedStyle(() => ({ width: `${w.get()}%` }));

/**
 * Progress toward a goal. signal: the screen's one hero meter (outlined track, signal fill, ink index tick);
 * neutral: everything else. The fill grows from the start edge by flex (mirrors in RTL, no `left:`). Over caps
 * the fill and turns it warning or danger (`over="none"`: past the goal is fine, e.g. hydration, so the fill
 * just stays full); the adjacent text must say so. Never shown without a readout.
 */
export function Meter({
  value,
  max,
  target,
  projected,
  over = "warning",
  tone = "neutral",
  size = "md",
  accessibilityLabel,
  valueText,
}: {
  value: number;
  max: number;
  target?: number;
  projected?: number;
  /** Colour past `max`; "none" keeps the normal fill (going past the goal is not a warning). */
  over?: "warning" | "danger" | "none";
  tone?: "signal" | "neutral";
  size?: "md" | "sm";
  accessibilityLabel: string;
  /** What the adjacent readout says, e.g. "1 840 of 2 200 kcal". Read as the value by screen readers. */
  valueText: string;
}) {
  const reduceMotion = useReducedMotionSafe();
  const signal = tone === "signal";
  const isOver = value > max && over !== "none";
  const fill = percent(value, max);
  const ahead = projected !== undefined && projected > value ? percent(projected, max) - fill : 0;
  const fillWidth = useWidth(fill, reduceMotion);
  const fillStyle = useWidthStyle(fillWidth);
  // The index tick rides the same animated value as the fill, so the two never disagree mid-change.
  const indexStyle = useWidthStyle(fillWidth);
  const aheadWidth = useWidth(ahead, reduceMotion);
  const aheadStyle = useWidthStyle(aheadWidth);
  const height = size === "sm" ? 4 : signal ? 8 : 4;
  const fillColor = isOver
    ? over === "danger"
      ? "bg-danger"
      : "bg-warning"
    : signal
      ? "bg-accent"
      : "bg-foreground-secondary";
  // Ticks sit on a spacer row so they position from the start edge by flex as well.
  const tick = (spacer: ReactNode, color: string) => (
    <View
      className="absolute inset-0 flex-row items-center"
      style={{ pointerEvents: "none" }}
      {...webHidden}
    >
      {spacer}
      <View
        className={twMerge("-ms-px w-0.5 rounded-mark", color)}
        style={{ height: height + 4 }}
      />
    </View>
  );
  // RN's bridge takes integers here, so the value is a percentage and `text` carries the readout.
  const a11yValue = { min: 0, max: 100, now: Math.round(fill), text: valueText };
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={accessibilityLabel}
      accessibilityValue={a11yValue}
      {...webA11y(null, a11yValue)}
      className="justify-center"
      style={{ minHeight: height + 4 }}
    >
      <View
        className={twMerge(
          "flex-row overflow-hidden rounded-mark bg-surface-tertiary",
          signal && "border border-border-strong"
        )}
        style={{ height }}
      >
        <Animated.View className={fillColor} style={fillStyle} />
        {ahead > 0 ? (
          <Animated.View className={twMerge(fillColor, "opacity-40")} style={aheadStyle} />
        ) : null}
      </View>
      {target !== undefined && target < max
        ? tick(<View style={{ width: `${percent(target, max)}%` }} />, "bg-foreground-secondary")
        : null}
      {signal && fill > 0 ? tick(<Animated.View style={indexStyle} />, "bg-foreground") : null}
    </View>
  );
}

/** Skeleton rows shaped like a list result: radius 2, static at 60%, no shimmer. */
function Skeleton({ rows = 3 }: { rows?: number }) {
  return (
    <View
      className="gap-4 opacity-60"
      importantForAccessibility="no-hide-descendants"
      {...webHidden}
    >
      {Array.from({ length: rows }, (_, i) => (
        <View key={i} className="gap-2">
          <View className="h-4 w-3/5 rounded-mark bg-surface-tertiary" />
          <View className="h-3 w-2/5 rounded-mark bg-surface-tertiary" />
        </View>
      ))}
    </View>
  );
}

/** Loading states wait 300ms before drawing anything, so fast reads never flash. */
function useDelayed(ms: number) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setShown(true), ms);
    return () => clearTimeout(id);
  }, [ms]);
  return shown;
}

function Loading() {
  const strings = useKitStrings();
  const shown = useDelayed(duration.slow);
  if (!shown) return null;
  return (
    <View accessible accessibilityLabel={strings.loading} accessibilityRole="progressbar">
      <Skeleton />
    </View>
  );
}

/**
 * Empty, loading and error states, start-aligned where the data would be. No illustration. `code` is a Label
 * ("No records" renders as NO RECORDS in cased scripts), `message` the sentence, `action` one way forward.
 */
export function SystemState({
  kind,
  code,
  message,
  action,
}: {
  kind: "empty" | "loading" | "error";
  code?: string;
  message?: string;
  action?: { label: string; onPress: () => void };
}) {
  const strings = useKitStrings();
  if (kind === "loading") return <Loading />;
  if (kind === "error") {
    return (
      <View className="items-start gap-3">
        {code ? <Label>{code}</Label> : null}
        <ErrorText message={message ?? ""} />
        {action ? (
          <Button variant="secondary" onPress={action.onPress}>
            {action.label || strings.retry}
          </Button>
        ) : null}
      </View>
    );
  }
  return (
    <View className="items-start gap-2">
      {code ? <Label>{code}</Label> : null}
      {message ? <Text>{message}</Text> : null}
      {action ? <LinkButton onPress={action.onPress}>{action.label}</LinkButton> : null}
    </View>
  );
}

const SCAN_LIMIT_MS = 5000;

/**
 * The 1pt sweep: runs for 5s at most (WCAG 2.2.2), mirrors in RTL, and is absent under Reduce Motion. It is a
 * line, so it is ink cyan (`tint`): a 1pt #22D3EE line on white is banned (design-system §2.4).
 */
function Scan() {
  const { isRTL } = useKit();
  const reduceMotion = useReducedMotionSafe();
  const [width, setWidth] = useState(0);
  const [done, setDone] = useState(false);
  const x = useSharedValue(0);
  useEffect(() => {
    if (reduceMotion || !width) return;
    x.set(0);
    x.set(
      withRepeat(
        withTiming(1, { duration: duration.scan, easing: easing.linear }),
        Math.floor(SCAN_LIMIT_MS / duration.scan),
        false
      )
    );
    const id = setTimeout(() => setDone(true), SCAN_LIMIT_MS);
    return () => {
      clearTimeout(id);
      cancelAnimation(x);
    };
  }, [reduceMotion, width, x]);
  const segment = width / 4;
  const style = useAnimatedStyle(() => ({
    // translateX is physical, so the travel is negated in RTL to keep the sweep moving start → end.
    transform: [{ translateX: (isRTL ? -1 : 1) * x.get() * (width - segment) }],
  }));
  if (reduceMotion || done) return null;
  return (
    <View
      className="h-px overflow-hidden"
      importantForAccessibility="no-hide-descendants"
      {...webHidden}
      onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}
    >
      <Animated.View className="h-px bg-tint" style={[{ width: segment }, style]} />
    </View>
  );
}

const two = (n: number) => String(Math.max(0, Math.round(n))).padStart(2, "0");

/**
 * Long work the user waits on: AI analysis, import, backup, first health sync. `Status live` + label; with a
 * count, a neutral Meter and a mono `04 / 07` counter.
 */
export function ProcessLine({
  label,
  done,
  total,
}: {
  label: string;
  done?: number;
  total?: number;
}) {
  const counted = done !== undefined && total !== undefined && total > 0;
  // Latin digits, like durations: the counter is a mono readout.
  const count = counted ? `${two(done)} / ${two(total)}` : "";
  return (
    <View className="gap-2" accessibilityLiveRegion="polite">
      <Status state="live" label={label} meta={count || undefined} />
      <Scan />
      {counted ? (
        <Meter value={done} max={total} size="sm" accessibilityLabel={label} valueText={count} />
      ) : null}
    </View>
  );
}
