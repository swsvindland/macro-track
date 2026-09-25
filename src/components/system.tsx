import type { ComponentProps } from "react";
import { Text as NativeText, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Button, Card, useThemeColor, type ThemeColor } from "heroui-native";
import { twMerge } from "tailwind-merge";

export type IconName = ComponentProps<typeof Ionicons>["name"];

/** Shared native primitives; HeroUI retains control behavior and accessibility. */
export function SystemText({ className, ...props }: ComponentProps<typeof NativeText>) {
  return (
    <NativeText {...props} className={twMerge("font-sans text-base text-foreground", className)} />
  );
}

export function SystemLabel({ className, ...props }: ComponentProps<typeof NativeText>) {
  return (
    <SystemText
      {...props}
      className={twMerge(
        "font-mono text-xs uppercase leading-4 tracking-wider text-muted",
        className
      )}
    />
  );
}

export function SystemValue({ className, ...props }: ComponentProps<typeof NativeText>) {
  return (
    <SystemText
      {...props}
      className={twMerge("font-mono text-5xl leading-tight tabular-nums", className)}
    />
  );
}

/** One icon family keeps compact controls visually consistent. */
export function SystemIcon({
  name,
  size = 20,
  color = "foreground",
}: {
  name: IconName;
  size?: number;
  color?: ThemeColor;
}) {
  const value = useThemeColor(color);
  return <Ionicons name={name} size={size} color={String(value)} />;
}

export function SystemButton({
  className,
  variant = "primary",
  icon,
  labelClassName,
  children,
  ...props
}: ComponentProps<typeof Button> & { icon?: IconName; labelClassName?: string }) {
  const iconColor: ThemeColor =
    variant === "primary"
      ? "accent-foreground"
      : variant === "danger-soft"
        ? "danger"
        : "accent-soft-foreground";
  return (
    <Button
      {...props}
      variant={variant}
      className={twMerge(
        "min-h-11 h-auto min-w-11 rounded-2xl px-4 py-3 shadow-none",
        "border border-transparent focus:border-focus",
        variant === "outline" && "border-border",
        variant === "secondary" && "bg-surface-secondary",
        className
      )}
    >
      {(icon || labelClassName) && typeof children === "string" ? (
        <>
          {icon && <SystemIcon name={icon} size={18} color={iconColor} />}
          <Button.Label className={labelClassName}>{children}</Button.Label>
        </>
      ) : (
        children
      )}
    </Button>
  );
}

/** Icon-only button with a 44pt target; the label is required for screen readers. */
export function SystemIconButton({
  icon,
  accessibilityLabel,
  variant = "ghost",
  color,
  iconSize = 22,
  className,
  ...props
}: ComponentProps<typeof Button> & {
  icon: IconName;
  accessibilityLabel: string;
  color?: ThemeColor;
  iconSize?: number;
}) {
  return (
    <Button
      {...props}
      isIconOnly
      variant={variant}
      accessibilityLabel={accessibilityLabel}
      className={twMerge(
        "h-11 w-11 min-w-11 rounded-full border border-transparent p-0 shadow-none",
        variant === "secondary" && "bg-surface-secondary",
        className
      )}
    >
      <SystemIcon
        name={icon}
        size={iconSize}
        color={color ?? (variant === "primary" ? "accent-foreground" : "foreground")}
      />
    </Button>
  );
}

const width = (value: number, scale: number) =>
  `${Math.max(0, Math.min(100, (value / scale) * 100))}%` as const;

/**
 * Calories against the day's target. The solid fill is what was eaten; the lighter
 * extension is what usually follows today; anything past the tick is over target.
 */
export function PaceBar({
  eaten,
  target,
  projected,
  warn,
  description,
}: {
  eaten: number;
  target: number;
  projected: number | null;
  /** Colors the projected overshoot amber; small overshoots within tolerance stay neutral. */
  warn: boolean;
  description: string;
}) {
  const scale = Math.max(target * 1.15, eaten, projected ?? 0, 1);
  const within = Math.min(eaten, target);
  const ahead = projected !== null && projected > eaten ? projected : eaten;
  const segments: { from: number; to: number; className: string }[] = [
    { from: 0, to: within, className: "bg-accent-soft-foreground" },
    { from: target, to: eaten, className: "bg-danger" },
    { from: eaten, to: Math.min(ahead, target), className: "bg-accent-soft-foreground opacity-40" },
    {
      from: Math.max(eaten, target),
      to: ahead,
      className: warn ? "bg-warning opacity-70" : "bg-accent-soft-foreground opacity-40",
    },
  ];
  return (
    <View
      className="h-3.5 justify-center"
      accessibilityRole="progressbar"
      accessibilityLabel="Calories"
      accessibilityValue={{
        min: 0,
        max: Math.round(target),
        now: Math.round(Math.min(eaten, target)),
        text: description,
      }}
    >
      <View className="h-2 overflow-hidden rounded-full bg-border">
        {segments
          .filter((segment) => segment.to > segment.from)
          .map((segment, i) => (
            <View
              key={i}
              className={twMerge("absolute inset-y-0", segment.className)}
              style={{
                left: width(segment.from, scale),
                width: width(segment.to - segment.from, scale),
              }}
            />
          ))}
      </View>
      <View
        className="absolute h-3.5 w-0.5 rounded-full bg-foreground"
        style={{ left: width(target, scale) }}
      />
    </View>
  );
}

/** Neutral macro progress, so calories stay the only colored signal on Home. */
export function MiniBar({ value, max }: { value: number; max: number }) {
  return (
    <View className="h-1 overflow-hidden rounded-full bg-border">
      <View
        className={twMerge("h-1 rounded-full", value > max ? "bg-warning" : "bg-muted")}
        style={{ width: width(value, Math.max(max, 1)) }}
      />
    </View>
  );
}

function Panel({ className, ...props }: ComponentProps<typeof Card>) {
  return (
    <Card
      {...props}
      className={twMerge("rounded-3xl border-0 bg-surface p-5 shadow-none", className)}
    />
  );
}

export const SystemPanel = Object.assign(Panel, {
  Body: Card.Body,
  Header: Card.Header,
  Footer: Card.Footer,
  Title: Card.Title,
  Description: Card.Description,
});
