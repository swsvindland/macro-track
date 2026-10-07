import { createContext, useContext, type Ref } from "react";
import {
  Pressable,
  View,
  type AccessibilityRole,
  type AccessibilityState,
  type AccessibilityValue,
  type Insets,
} from "react-native";
import { Button as HeroButton } from "heroui-native";
import { twMerge } from "tailwind-merge";
import { Icon, type IconTone } from "./icon";
import type { IconName } from "./icons";
import { useKit, useSignalBudget, webA11y } from "./provider";
import { Text } from "./text";

/** Pass-through a11y and press props shared by Button and IconButton (KIT §6). */
type PressA11y = {
  accessibilityLabel?: string;
  accessibilityHint?: string;
  accessibilityRole?: AccessibilityRole;
  accessibilityState?: AccessibilityState;
  accessibilityValue?: AccessibilityValue;
  hitSlop?: number | Insets;
  onLongPress?: () => void;
  /** Forwarded to the pressable: Menu/Popover triggers (asChild) measure it to place their content. */
  ref?: Ref<View>;
};

/** True inside a live ScreenFooter strip: links and glyphs switch to signal ink (tint is 3.16:1 on signal). */
const OnSignal = createContext(false);
export const OnSignalProvider = OnSignal.Provider;

// Press is a colour change only: feedbackVariant "none" drops HeroUI's scale, highlight and ripple (same prop in
// 1.0.8 and 1.0.9), and Uniwind's Pressable resolves `active:` from the pressed state. Focus is a 2pt tint ring.
const pressable = "focus:outline-2 focus:outline-offset-2 focus:outline-tint";

const variants = {
  // Signal fill with signal ink (the icon look); pressed = HeroUI's derived accent-hover, never a hex.
  primary: { hero: "primary", root: "active:bg-accent-hover", label: "", icon: "onSignal" },
  // Never a grey fill: surface with a control edge.
  secondary: {
    hero: "outline",
    root: "border border-border-strong bg-surface active:bg-surface-secondary",
    label: "text-foreground",
    icon: "foreground",
  },
  ghost: { hero: "ghost", root: "active:bg-surface-secondary", label: "text-tint", icon: "tint" },
  // Delete at the end of an Editor, "Erase all data": danger words, no fill.
  destructive: {
    hero: "ghost",
    root: "active:bg-surface-secondary",
    label: "text-danger",
    icon: "danger",
  },
} as const satisfies Record<
  string,
  { hero: "primary" | "outline" | "ghost"; root: string; label: string; icon: IconTone }
>;

type Variant = keyof typeof variants;
type Look = { hero: "primary" | "outline" | "ghost"; root: string; label: string; icon: IconTone };

/** A ghost on the live strip (e.g. Skip) reads in signal ink: tint on signal is only 3.16:1. */
const lookFor = (variant: Variant, onSignal: boolean): Look =>
  onSignal && variant === "ghost"
    ? {
        ...variants.ghost,
        root: "active:bg-accent-hover",
        label: "text-accent-foreground",
        icon: "onSignal",
      }
    : variants[variant];

/**
 * The Button look as data, for a migration shim's HeroUI fallback (children or icons the kit Button does not
 * take), so the shim never copies the classes. Spread `variant`, `feedbackVariant` and `className` onto a
 * HeroUI Button, `labelClassName` onto its Label, and draw glyphs at 17 in `iconTone`.
 */
export function buttonLook(
  variant: Variant = "primary",
  { size = "md", onSignal = false }: { size?: "md" | "lg"; onSignal?: boolean } = {}
) {
  const v = lookFor(variant, onSignal);
  return {
    variant: v.hero,
    feedbackVariant: "none" as const,
    className: twMerge(
      "h-auto rounded-control",
      size === "lg" ? "min-h-13 px-5 py-4" : "min-h-11 px-4 py-3",
      pressable,
      v.root
    ),
    labelClassName: twMerge("text-center", v.label),
    iconTone: v.icon,
  };
}

/** The IconButton look as data (44×44, glyph 20 in `iconTone`), for the same shim fallback. */
export function iconButtonLook(
  variant: "ghost" | "secondary" | "primary" = "ghost",
  {
    tone = "foreground",
    onSignal = false,
  }: { tone?: "foreground" | "tint" | "danger"; onSignal?: boolean } = {}
) {
  return {
    variant: variant === "secondary" ? ("outline" as const) : variant,
    feedbackVariant: "none" as const,
    isIconOnly: true as const,
    className: twMerge(
      "h-11 min-h-11 w-11 min-w-11 rounded-control p-0",
      pressable,
      variants[variant].root,
      // A ghost glyph on the live strip presses to a darker signal, not a grey square.
      onSignal && variant === "ghost" && "active:bg-accent-hover"
    ),
    iconTone: (variant === "primary" || onSignal ? "onSignal" : tone) as IconTone,
  };
}

/** One line that shrinks before it clips: only for genuinely fixed slots such as the dock strip. */
const fitted = {
  numberOfLines: 1,
  adjustsFontSizeToFit: true,
  minimumFontScale: 0.8,
  maxFontSizeMultiplier: 1.3,
} as const;

export type ButtonProps = PressA11y & {
  variant?: "primary" | "secondary" | "ghost" | "destructive";
  /** md = 44 (default); lg = 52, the pinned footer primary. */
  size?: "md" | "lg";
  icon?: IconName;
  iconPosition?: "start" | "end";
  fit?: boolean;
  /** Disables the button and swaps the label for `loadingLabel` (default: kit "Saving…"). No spinner. */
  loading?: boolean;
  loadingLabel?: string;
  disabled?: boolean;
  onPress: () => void;
  /** Layout only: margin, flex, self-alignment. Never colour, size or radius. */
  className?: string;
  /** Verb + object in sentence case. */
  children: string;
};

/** The one button. Labels wrap (min-h + h-auto); a screen has at most one primary (checked in development). */
export function Button({
  variant = "primary",
  size = "md",
  icon,
  iconPosition = "start",
  fit = false,
  loading = false,
  loadingLabel,
  disabled = false,
  className,
  accessibilityState,
  accessibilityValue,
  children,
  ...rest
}: ButtonProps) {
  const { strings, boldText } = useKit();
  const onSignal = useContext(OnSignal);
  useSignalBudget(variant === "primary");
  const look = buttonLook(variant, { size, onSignal });
  const inactive = disabled || loading;
  const glyph = icon ? <Icon name={icon} size={17} tone={look.iconTone} /> : null;
  const state = { ...accessibilityState, disabled: inactive, busy: loading };
  return (
    <HeroButton
      {...rest}
      variant={look.variant}
      size={size}
      feedbackVariant={look.feedbackVariant}
      isDisabled={inactive}
      // HeroUI sets {disabled} before spreading props; merge so a caller's state never drops it.
      accessibilityState={state}
      accessibilityValue={accessibilityValue}
      // A selected button is a toggle on web (aria-selected means nothing on a button).
      {...webA11y(state, accessibilityValue, "pressed")}
      className={twMerge(look.className, className)}
    >
      {iconPosition === "start" ? glyph : null}
      <HeroButton.Label
        // Size and weight come from .button__label--size-* (tokens.css): 15/20 at 500; Bold Text steps it up.
        className={look.labelClassName}
        style={boldText ? { fontWeight: "600" } : undefined}
        maxFontSizeMultiplier={1.6}
        {...(fit ? fitted : {})}
      >
        {loading ? (loadingLabel ?? strings.processing) : children}
      </HeroButton.Label>
      {iconPosition === "end" ? glyph : null}
    </HeroButton>
  );
}

export type IconButtonProps = Omit<PressA11y, "accessibilityLabel"> & {
  icon: IconName;
  /** Required: an icon-only control has no visible words. */
  accessibilityLabel: string;
  variant?: "ghost" | "secondary" | "primary";
  /** Glyph colour for ghost/secondary; tint when it is the screen's action. Primary is always signal ink. */
  tone?: "foreground" | "tint" | "danger";
  disabled?: boolean;
  onPress: () => void;
};

/** 44×44 square, radius 4. Round icon buttons belong to the system. */
export function IconButton({
  icon,
  variant = "ghost",
  tone = "foreground",
  disabled = false,
  accessibilityState,
  accessibilityValue,
  ...rest
}: IconButtonProps) {
  const onSignal = useContext(OnSignal);
  useSignalBudget(variant === "primary");
  const look = iconButtonLook(variant, { tone, onSignal });
  const state = { ...accessibilityState, disabled };
  return (
    <HeroButton
      {...rest}
      isIconOnly={look.isIconOnly}
      variant={look.variant}
      feedbackVariant={look.feedbackVariant}
      isDisabled={disabled}
      accessibilityState={state}
      accessibilityValue={accessibilityValue}
      {...webA11y(state, accessibilityValue, "pressed")}
      className={look.className}
    >
      <Icon name={icon} size={20} tone={look.iconTone} />
    </HeroButton>
  );
}

export type LinkButtonProps = {
  /** Trailing glyph, e.g. `forward` (mirrors in RTL). */
  icon?: IconName;
  onPress: () => void;
  /** "link" when it leaves the app (an external source, a web page); default "button". */
  accessibilityRole?: "button" | "link";
  /** When the visible words need more context, e.g. "Back to today" for "Today". */
  accessibilityLabel?: string;
  accessibilityHint?: string;
  /** Merged with `disabled`, e.g. `{ expanded }` for a Why? / Less toggle. */
  accessibilityState?: AccessibilityState;
  /** Editor Cancel is disabled while a save runs. */
  disabled?: boolean;
  children: string;
};

/** Inline text action in tint, 15/20 at 500. Replaces the ghost-link idioms. Pressed opacity 0.6. */
export function LinkButton({
  icon,
  onPress,
  accessibilityRole = "button",
  accessibilityLabel,
  accessibilityHint,
  accessibilityState,
  disabled = false,
  children,
}: LinkButtonProps) {
  const onSignal = useContext(OnSignal);
  const tone = onSignal ? "onSignal" : "tint";
  const state = { ...accessibilityState, disabled };
  return (
    <Pressable
      accessibilityRole={accessibilityRole}
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityState={state}
      {...webA11y(state, null, accessibilityRole === "link" ? "current" : "pressed")}
      disabled={disabled}
      onPress={onPress}
      hitSlop={4}
      className={twMerge(
        "min-h-11 flex-row items-center gap-1 self-start active:opacity-60",
        pressable,
        disabled && "opacity-disabled"
      )}
    >
      {/* shrink: a long translation wraps before the trailing glyph instead of pushing it out. */}
      <Text variant="h4" tone={tone} className="shrink">
        {children}
      </Text>
      {icon ? <Icon name={icon} size={17} tone={tone} /> : null}
    </Pressable>
  );
}
