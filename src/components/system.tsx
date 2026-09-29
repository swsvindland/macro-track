import {
  Children,
  isValidElement,
  type ComponentProps,
  type ComponentPropsWithRef,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  Text as NativeText,
  View,
  type GestureResponderEvent,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { isSharedValue, type SharedValue } from "react-native-reanimated";
import { Button as HeroButton, type ThemeColor } from "heroui-native";
import { twMerge } from "tailwind-merge";
import {
  Button,
  Heading,
  Icon,
  IconButton,
  Label,
  Meter,
  Note,
  Panel,
  Text,
  Value,
  buttonLook,
  iconButtonLook,
  type IconName,
  type PanelProps,
  type RoleName,
} from "@/vector";
import { useStore } from "@/lib/store";

/**
 * Migration shim (KIT §7): the old system.tsx names over the Vector kit, so every call site keeps
 * compiling while it moves to "@/vector". App-specific parts (PaceBar) live here until their
 * screens are migrated.
 */

/**
 * The kit type role a legacy class list asked for; kit Text owns size and weight, so the classes
 * alone do nothing.
 */
function roleOf(className: string | undefined): RoleName {
  const has = (re: RegExp) => !!className && re.test(className);
  const size = /(?:^|\s)text-(xs|sm|base|lg|xl|2xl|3xl|4xl|5xl)(?=\s|$)/.exec(className ?? "")?.[1];
  if (has(/(?:^|\s)(?:font-mono|tabular-nums)(?=\s|$)/)) {
    if (size === "5xl") return "readoutXL";
    if (size === "3xl" || size === "4xl") return "readoutL";
    if (size === "lg" || size === "xl" || size === "2xl") return "readoutM";
    if (size === "xs") return "readoutXS";
    if (has(/(?:^|\s)font-mono(?=\s|$)/)) return "readoutS";
  }
  const strong = has(/(?:^|\s)font-(?:medium|semibold|bold)(?=\s|$)/);
  if (size === "3xl" || size === "4xl" || size === "5xl") return "h1";
  if (size === "2xl") return "h2";
  if (size === "lg" || size === "xl") return "h3";
  if (size === "sm") return "small";
  if (size === "xs") return "caption";
  return strong ? "bodyStrong" : "body";
}

/** Kit Text. A positioned `style` (the old chart labels) keeps the RN Text it was written for. */
export function SystemText({
  className,
  style,
  allowFontScaling,
  ...props
}: ComponentProps<typeof NativeText>) {
  if (style !== undefined || allowFontScaling !== undefined) {
    return (
      <NativeText
        {...props}
        style={style}
        allowFontScaling={allowFontScaling}
        className={twMerge("font-sans text-base text-foreground", className)}
      />
    );
  }
  return <Text {...props} variant={roleOf(className)} className={className} />;
}

/**
 * Kit Label: eyebrows, table headers, status words. Wraps like the old label unless told otherwise.
 */
export function SystemLabel({
  numberOfLines,
  style: _style,
  allowFontScaling: _scaling,
  ...props
}: ComponentProps<typeof NativeText>) {
  return <Label {...props} numberOfLines={numberOfLines} />;
}

/** A string child is a kit Value; anything else reads as a small readout. */
export function SystemValue({
  children,
  style: _style,
  allowFontScaling: _scaling,
  ...props
}: ComponentProps<typeof NativeText>) {
  if (typeof children === "string") return <Value {...props} value={children} />;
  return (
    <Text {...props} variant="readoutS">
      {children}
    </Text>
  );
}

type HeroProps = ComponentPropsWithRef<typeof HeroButton>;
type Handler = ((event: GestureResponderEvent) => void) | null | undefined;
const noop = () => {};
/** The kit forwards onPress to the same HeroUI pressable, which still passes its event through. */
const press = (handler: Handler) => (handler ?? noop) as () => void;
/**
 * HeroUI types its pressable props as animatable; the ones the kit forwards are read as plain
 * values.
 */
const plain = <T,>(value: T | SharedValue<T>): T => (isSharedValue<T>(value) ? value.get() : value);

/** Splits the props both kit buttons forward from the ones only a HeroUI Button understands. */
function passThrough({
  ref,
  accessibilityLabel,
  accessibilityHint,
  accessibilityRole,
  accessibilityState,
  accessibilityValue,
  hitSlop,
  onLongPress,
  ...other
}: Omit<HeroProps, "variant" | "isDisabled" | "onPress" | "className" | "children">) {
  const longPress = plain(onLongPress);
  return {
    kit: {
      ref,
      accessibilityLabel: plain(accessibilityLabel),
      accessibilityHint: plain(accessibilityHint),
      accessibilityRole: plain(accessibilityRole),
      accessibilityState: plain(accessibilityState),
      accessibilityValue: plain(accessibilityValue),
      hitSlop: plain(hitSlop) ?? undefined,
      onLongPress: longPress ? press(longPress) : undefined,
    },
    // Set here means the call site needs the HeroUI Button (isIconOnly, accessibilityActions, …).
    heroOnly: Object.values(other).some((value) => value !== undefined),
  };
}

type HeroVariant = ComponentProps<typeof HeroButton>["variant"];
const kitVariant = (variant: HeroVariant) =>
  variant === "secondary" || variant === "outline" || variant === "tertiary"
    ? "secondary"
    : variant === "ghost"
      ? "ghost"
      : variant === "danger" || variant === "danger-soft"
        ? "destructive"
        : "primary";

/** A fixed-size button's label stays on one line, shrinking before it would be cut off. */
const fitted = {
  numberOfLines: 1,
  adjustsFontSizeToFit: true,
  minimumFontScale: 0.8,
  maxFontSizeMultiplier: 1.3,
} as const;

/** Plain text children, joined as HeroUI would ("Add ", 3, " foods"), or null for anything else. */
function textOf(children: ReactNode): string | null {
  let text = "";
  for (const child of Children.toArray(children)) {
    if (typeof child === "string" || typeof child === "number") text += child;
    else return null;
  }
  return text || null;
}

/**
 * Kit Button for a text label; the HeroUI Button with the kit's variant look for composed content,
 * a mark icon, or props the kit Button does not take (isIconOnly, accessibilityActions).
 */
export function SystemButton({
  className,
  variant = "primary",
  icon,
  labelClassName: _labelClassName,
  fit = false,
  children,
  isDisabled = false,
  onPress,
  ...props
}: ComponentPropsWithRef<typeof HeroButton> & {
  /** A registry name, or an element for a mark that isn't in the family. */
  icon?: IconName | ReactElement;
  /** Ignored: the kit owns the label style. */
  labelClassName?: string;
  fit?: boolean;
}) {
  const kind = kitVariant(variant);
  const label = textOf(children);
  const glyph = typeof icon === "string" ? icon : undefined;
  const { kit, heroOnly } = passThrough(props);
  if (label !== null && (icon === undefined || glyph !== undefined) && !heroOnly) {
    return (
      <Button
        {...kit}
        variant={kind}
        icon={glyph}
        fit={fit}
        disabled={isDisabled}
        className={className}
        onPress={press(plain(onPress))}
      >
        {label}
      </Button>
    );
  }
  // The kit Button's look as data, so the shim never copies its classes.
  const look = buttonLook(kind);
  const { animation: _animation, ...hero } = props;
  return (
    <HeroButton
      {...hero}
      variant={look.variant}
      feedbackVariant={look.feedbackVariant}
      isDisabled={isDisabled}
      onPress={onPress}
      className={twMerge(look.className, className)}
    >
      {glyph ? (
        <Icon name={glyph} size={17} tone={look.iconTone} />
      ) : isValidElement(icon) ? (
        icon
      ) : null}
      {label !== null ? (
        <HeroButton.Label className={look.labelClassName} {...(fit ? fitted : {})}>
          {label}
        </HeroButton.Label>
      ) : (
        children
      )}
    </HeroButton>
  );
}

const iconTone = (color: ThemeColor | undefined) =>
  color === "accent-soft-foreground" || color === "link" || color === "accent"
    ? "tint"
    : color === "danger"
      ? "danger"
      : "foreground";

/**
 * Kit IconButton for a registry name; the HeroUI Button with the kit IconButton look for a mark
 * element or a custom size.
 */
export function SystemIconButton({
  icon,
  accessibilityLabel,
  variant = "ghost",
  color,
  iconSize: _iconSize,
  className,
  isDisabled = false,
  onPress,
  ...props
}: ComponentPropsWithRef<typeof HeroButton> & {
  icon: IconName | ReactElement;
  accessibilityLabel: string;
  color?: ThemeColor;
  iconSize?: number;
}) {
  const kind = variant === "primary" ? "primary" : variant === "ghost" ? "ghost" : "secondary";
  const glyph = typeof icon === "string" ? icon : undefined;
  const { kit, heroOnly } = passThrough(props);
  if (glyph && !className && !heroOnly) {
    return (
      <IconButton
        {...kit}
        icon={glyph}
        variant={kind}
        tone={iconTone(color)}
        disabled={isDisabled}
        accessibilityLabel={accessibilityLabel}
        onPress={press(plain(onPress))}
      />
    );
  }
  // The kit IconButton's look as data, so the shim never copies its classes.
  const look = iconButtonLook(kind, { tone: iconTone(color) });
  const { animation: _animation, ...hero } = props;
  return (
    <HeroButton
      {...hero}
      isIconOnly={look.isIconOnly}
      variant={look.variant}
      feedbackVariant={look.feedbackVariant}
      isDisabled={isDisabled}
      onPress={onPress}
      accessibilityLabel={accessibilityLabel}
      className={twMerge(look.className, className)}
    >
      {glyph ? <Icon name={glyph} size={20} tone={look.iconTone} /> : icon}
    </HeroButton>
  );
}

/**
 * Calories against the day's target, on the kit's signal meter: the fill is what was eaten, the
 * lighter run what usually follows today, the tick the target. Over target the whole bar turns
 * warning, the kit's over-target colour (the text says by how much). `warn` is carried by the pace
 * text beside the bar.
 */
export function PaceBar({
  eaten,
  target,
  projected,
  description,
}: {
  eaten: number;
  target: number;
  projected: number | null;
  /** The projection runs past the target by more than the tolerance. */
  warn: boolean;
  description: string;
}) {
  const { t } = useStore();
  if (eaten > target) {
    return (
      <Meter
        tone="signal"
        value={eaten}
        max={Math.max(target, 1)}
        accessibilityLabel={t("calories")}
        valueText={description}
      />
    );
  }
  return (
    <Meter
      tone="signal"
      value={eaten}
      // Room past the target, so a projected overshoot stays visible.
      max={Math.max(target * 1.15, projected ?? 0, 1)}
      target={target}
      projected={projected ?? undefined}
      accessibilityLabel={t("calories")}
      valueText={description}
    />
  );
}

/**
 * Neutral macro progress, so calories stay the only signal on Home. Hidden from screen readers
 * without a label.
 */
export function MiniBar({
  value,
  max,
  accessibilityLabel,
}: {
  value: number;
  max: number;
  accessibilityLabel?: string;
}) {
  const meter = (
    <Meter
      tone="neutral"
      size="sm"
      value={value}
      max={Math.max(max, 1)}
      accessibilityLabel={accessibilityLabel ?? ""}
      valueText=""
    />
  );
  if (accessibilityLabel) return meter;
  // The readout beside it states the numbers; an unlabelled bar would only add a silent stop.
  return (
    <View importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
      {meter}
    </View>
  );
}

type ShimPanelProps = Omit<PanelProps, "children"> & {
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
};

function PanelRoot({ style, children, ...props }: ShimPanelProps) {
  const panel = <Panel {...props}>{children}</Panel>;
  return style ? <View style={style}>{panel}</View> : panel;
}

function PanelHeader({
  children,
  className,
  ...header
}: {
  eyebrow?: string;
  meta?: ReactNode;
  title?: string;
  children?: ReactNode;
  className?: string;
}) {
  const kit = header.eyebrow || header.meta != null || header.title;
  if (!children) return <Panel.Header {...header} />;
  return (
    <View className={twMerge("gap-2", className)}>
      {kit ? <Panel.Header {...header} /> : null}
      {children}
    </View>
  );
}
// Not counted as a row by `Panel inset="none"`, like the kit's own header.
PanelHeader.panelHeader = true as const;

const PanelTitle = ({ children, className }: { children: ReactNode; className?: string }) => (
  <Heading level={3} className={className}>
    {children}
  </Heading>
);
const PanelDescription = ({ children, className }: { children: ReactNode; className?: string }) => (
  <Note className={className}>{children}</Note>
);
const PanelFooter = ({ children, className }: { children: ReactNode; className?: string }) =>
  className ? (
    <View className={className}>
      <Panel.Footer>{children}</Panel.Footer>
    </View>
  ) : (
    <Panel.Footer>{children}</Panel.Footer>
  );

export const SystemPanel = Object.assign(PanelRoot, {
  Body: Panel.Body,
  Header: PanelHeader,
  Footer: PanelFooter,
  Title: PanelTitle,
  Description: PanelDescription,
});
