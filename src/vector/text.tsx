import { Fragment, useLayoutEffect, useState, type ReactNode } from "react";
import { Platform, Text as RNText, View, type TextProps, type TextStyle } from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from "react-native-reanimated";
import { twMerge } from "tailwind-merge";
import { isMonoSafe } from "./format";
import { duration, easing } from "./motion";
import { useKit, useSignalInk, type VectorKit } from "./provider";
import type { ScriptClass } from "./script";
import { fonts } from "./tokens";

type Weight = 400 | 500 | 600;
type Role = {
  size: number;
  line: number;
  weight: Weight;
  mono?: boolean;
  tracking?: number;
  cap: number;
  ramp?: TextProps["dynamicTypeRamp"];
};

/** The type scale (design-system §3.2). Weights are explicit numbers: Tailwind font-* utilities select a family. */
export const roles = {
  display: { size: 40, line: 44, weight: 600, tracking: -0.03, cap: 1.3, ramp: "largeTitle" },
  h1: { size: 28, line: 34, weight: 600, tracking: -0.02, cap: 1.6, ramp: "title1" },
  h2: { size: 22, line: 28, weight: 600, tracking: -0.01, cap: 1.6, ramp: "title2" },
  h3: { size: 17, line: 22, weight: 600, cap: 1.6, ramp: "headline" },
  h4: { size: 15, line: 20, weight: 500, cap: 1.8, ramp: "subheadline" },
  body: { size: 16, line: 24, weight: 400, cap: 2, ramp: "body" },
  bodyStrong: { size: 16, line: 24, weight: 500, cap: 2, ramp: "body" },
  small: { size: 14, line: 20, weight: 400, cap: 2, ramp: "subheadline" },
  caption: { size: 12, line: 16, weight: 400, cap: 2, ramp: "caption1" },
  fieldLabel: { size: 14, line: 20, weight: 500, cap: 1.8, ramp: "subheadline" },
  label: {
    size: 11,
    line: 16,
    weight: 400,
    mono: true,
    tracking: 0.08,
    cap: 1.8,
    ramp: "caption2",
  },
  readoutXL: {
    size: 48,
    line: 52,
    weight: 400,
    mono: true,
    tracking: -0.02,
    cap: 1.25,
    ramp: "largeTitle",
  },
  readoutL: {
    size: 34,
    line: 40,
    weight: 400,
    mono: true,
    tracking: -0.01,
    cap: 1.4,
    ramp: "largeTitle",
  },
  readoutM: { size: 22, line: 28, weight: 400, mono: true, cap: 1.6, ramp: "title2" },
  readoutS: { size: 16, line: 24, weight: 400, mono: true, cap: 2, ramp: "body" },
  readoutXS: { size: 12, line: 16, weight: 400, mono: true, cap: 2, ramp: "caption1" },
} satisfies Record<string, Role>;
export type RoleName = keyof typeof roles;

const familyFor = {
  400: fonts.normal,
  500: fonts.medium,
  600: fonts.semibold,
  700: fonts.bold,
} as const;
/** Flag cjkSystemFamilies (§12 #8): the app language's own iOS face. Inter has no CJK glyphs, and iOS falls back
 *  by the device language, so a ja app on an en or zh device would otherwise draw Chinese kanji shapes. */
const cjkFamily: Partial<Record<string, string>> = {
  ja: "Hiragino Sans",
  ko: "Apple SD Gothic Neo",
  zh: "PingFang SC",
};
/** The sans family for a weight: Inter (per-weight entries from tokens.json), or the flagged CJK system face. */
export function sansFamily(
  weight: 400 | 500 | 600 | 700,
  kit: Pick<VectorKit, "language" | "script" | "flags">
): string {
  const cjk = kit.flags.cjkSystemFamilies && Platform.OS === "ios" && kit.script === "cjk";
  return (cjk && cjkFamily[kit.language]) || familyFor[weight];
}
/** Numeric weight (variable Inter) + its family. Bold Text steps every sans role up 100. */
const weightStyle = (
  w: Weight,
  bold: boolean,
  kit: Pick<VectorKit, "language" | "script" | "flags">
): TextStyle => {
  const final = (bold ? Math.min(w + 100, 700) : w) as 400 | 500 | 600 | 700;
  return {
    fontFamily: sansFamily(final, kit),
    fontWeight: String(final) as TextStyle["fontWeight"],
  };
};

/** Resolves a role for the active script (design-system §3.4). */
export function resolveRole(name: RoleName, script: ScriptClass): Role & { upper: boolean } {
  const r: Role = roles[name];
  if (name === "label") {
    if (script === "cased") return { ...r, upper: true };
    // Uncased scripts: no case to set and letter-spacing breaks CJK rhythm and Arabic joining → sans 12/18 500.
    const line = script === "arabic" ? Math.round(18 * 1.15) : 18;
    return { size: 12, line, weight: 500, cap: 1.8, ramp: "caption2", upper: false };
  }
  let line = r.line;
  if (script === "cjk" && !r.mono) line = Math.max(line, Math.round(r.size * 1.6));
  if (script === "arabic") line = Math.round(line * 1.15);
  return { ...r, line, tracking: script === "cased" ? r.tracking : 0, upper: false };
}

export type VectorTextProps = Omit<TextProps, "style" | "allowFontScaling"> & {
  /** Type role (named 'variant' because RN Text already has an ARIA 'role' prop). */
  variant?: RoleName;
  tone?: "default" | "secondary" | "muted" | "tint" | "success" | "warning" | "danger" | "onSignal";
  className?: string;
  children?: ReactNode;
};

const toneClass = {
  default: "text-foreground",
  secondary: "text-foreground-secondary",
  muted: "text-muted",
  tint: "text-tint",
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
  onSignal: "text-accent-foreground",
} as const;

/**
 * The only Text in app code. `text-left` means start: RN resolves it against the layout direction. Inside a
 * selected SignalCell it is signal ink whatever `tone` or class it is given (useSignalInk).
 */
export function Text({
  variant = "body",
  tone = "default",
  className,
  maxFontSizeMultiplier,
  children,
  ...rest
}: VectorTextProps) {
  const kit = useKit();
  const ink = useSignalInk();
  const { script, boldText } = kit;
  const r = resolveRole(variant, script);
  // Readouts: Plex Mono only for digits and numeric punctuation, else Inter with fixed-width digits (ideographic
  // dates, future Arabic-Indic digits). Eyebrow labels keep Plex Mono for their words; resolveRole already made
  // them sans for uncased scripts.
  const mono =
    !!r.mono && (variant === "label" || typeof children !== "string" || isMonoSafe(children));
  const family: TextStyle = mono
    ? { fontFamily: fonts.mono, fontWeight: "400", fontVariant: ["tabular-nums"] }
    : r.mono
      ? { ...weightStyle(r.weight, boldText, kit), fontVariant: ["tabular-nums"] }
      : weightStyle(r.weight, boldText, kit);
  return (
    <RNText
      {...rest}
      // A caller may lower the role's cap (chart ticks at 1.3, fitted slots) but never raise it.
      maxFontSizeMultiplier={Math.min(maxFontSizeMultiplier ?? r.cap, r.cap)}
      dynamicTypeRamp={r.ramp}
      className={twMerge("text-left", toneClass[tone], className, ink && toneClass.onSignal)}
      style={[
        {
          fontSize: r.size,
          lineHeight: r.line,
          letterSpacing: (r.tracking ?? 0) * r.size,
          textTransform: r.upper ? "uppercase" : "none",
        },
        family,
      ]}
    >
      {children}
    </RNText>
  );
}

/**
 * SIBYL eyebrow / table header / status word / panel meta. Never a section heading. One line by default;
 * `numberOfLines={0}` (or 2) lets a long translation wrap where the slot can grow.
 */
export const Label = (p: Omit<VectorTextProps, "variant">) => (
  <Text variant="label" tone="muted" numberOfLines={1} {...p} />
);

export const Heading = ({
  level,
  ...p
}: Omit<VectorTextProps, "variant"> & { level: 1 | 2 | 3 | 4 }) => (
  <Text
    variant={(["h1", "h2", "h3", "h4"] as const)[level - 1]}
    accessibilityRole="header"
    {...p}
  />
);

/** `small` muted: replaces `text-sm text-muted`. */
export const Note = ({ tone = "muted", ...p }: Omit<VectorTextProps, "variant">) => (
  <Text variant="small" tone={tone} {...p} />
);

/** The ink switches back at the fade's midpoint, where either ink still clears 3:1 on the half-faded block. */
const PULSE_INK_MS = duration.pulse - duration.slow / 2;

/**
 * Signal pulse (design-system §7): on a pulseKey change the block holds 300ms, then fades 300ms. The block stays
 * mounted and only its opacity animates, so the signal-ink digits never outlive it. Off under Reduce Motion.
 */
function usePulse(pulseKey: string | number | undefined, reduceMotion: boolean) {
  const [seen, setSeen] = useState(pulseKey);
  const [on, setOn] = useState(false);
  const opacity = useSharedValue(0);
  // Adjusting state while rendering (not in an effect) starts the pulse in the same frame as the new value.
  if (seen !== pulseKey) {
    setSeen(pulseKey);
    setOn(!reduceMotion && pulseKey !== undefined);
  }
  // Layout effect: the block is raised before paint, in the same frame the digits turn signal ink.
  useLayoutEffect(() => {
    if (!on) return;
    opacity.set(1);
    opacity.set(
      withDelay(
        duration.pulse - duration.slow,
        withTiming(0, { duration: duration.slow, easing: easing.exit })
      )
    );
    const id = setTimeout(() => setOn(false), PULSE_INK_MS);
    return () => clearTimeout(id);
  }, [on, pulseKey, opacity]);
  const block = useAnimatedStyle(() => ({ opacity: opacity.get() }));
  return { on, block };
}

/** No-break space: the fallback between value and unit, so a unit never wraps away from its number. */
const NBSP = "\u00A0";

/** A measured number. Plex Mono only when the formatted string is digits and numeric punctuation (isMonoSafe). */
export function Value({
  value,
  unit,
  size = "s",
  tone = "default",
  unitFirst = false,
  space = NBSP,
  pulseKey,
  ...rest
}: Omit<VectorTextProps, "variant" | "children"> & {
  value: string;
  unit?: string;
  size?: "xl" | "l" | "m" | "s" | "xs";
  unitFirst?: boolean;
  /** The locale's value–unit spacing, from `format.unitParts` ("" in ko "72.5mL" and zh "2升"). */
  space?: string;
  /** Change it on a user commit to run the signal pulse. */
  pulseKey?: string | number;
}) {
  const { reduceMotion } = useKit();
  const pulse = usePulse(pulseKey, reduceMotion);
  const ink = pulse.on ? "onSignal" : undefined;
  const role = (
    { xl: "readoutXL", l: "readoutL", m: "readoutM", s: "readoutS", xs: "readoutXS" } as const
  )[size];
  // Units at about 45% of the value, muted, sans: a separate run so the locale decides order and spacing.
  const unitRole = ({ xl: "h2", l: "h4", m: "small", s: "caption", xs: "caption" } as const)[size];
  const gap = space.replace(/ /g, NBSP);
  const u = unit ? (
    <Text variant={unitRole} tone={ink ?? "muted"}>
      {unitFirst ? `${unit}${gap}` : `${gap}${unit}`}
    </Text>
  ) : null;
  const text = (
    <Text variant={role} tone={tone} {...rest}>
      {unitFirst ? u : null}
      <Text variant={role} tone={ink ?? tone}>
        {value}
      </Text>
      {unitFirst ? null : u}
    </Text>
  );
  if (pulseKey === undefined) return text;
  return (
    <View className="self-start">
      <Animated.View
        className="absolute inset-0 rounded-mark bg-accent"
        style={pulse.block}
        importantForAccessibility="no"
      />
      {text}
    </View>
  );
}

/** Facets separated by a drawn 3pt dot (never a typed " · "); VoiceOver reads them as a list. */
export function Meta({ items, tone = "muted" }: { items: string[]; tone?: "muted" | "default" }) {
  const shown = items.filter(Boolean);
  return (
    <View className="flex-row flex-wrap items-center gap-x-2" accessibilityRole="list">
      {shown.map((item, i) => (
        <Fragment key={`${i}:${item}`}>
          {i > 0 ? (
            <View
              className={twMerge(
                "size-[3px] rounded-mark",
                tone === "muted" ? "bg-muted" : "bg-foreground"
              )}
              importantForAccessibility="no"
            />
          ) : null}
          <Text variant="small" tone={tone}>
            {item}
          </Text>
        </Fragment>
      ))}
    </View>
  );
}
