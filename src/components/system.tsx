import type { ComponentProps } from "react";
import { Text as NativeText } from "react-native";
import { Button, Card } from "heroui-native";
import { twMerge } from "tailwind-merge";

/** Sibyl visual primitives; HeroUI retains control behavior and accessibility. */
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

export function SystemButton({
  className,
  variant = "primary",
  ...props
}: ComponentProps<typeof Button>) {
  return (
    <Button
      {...props}
      variant={variant}
      className={twMerge(
        "min-h-11 h-auto min-w-11 rounded-md px-4 py-3 shadow-none",
        "border border-transparent focus:border-focus",
        variant === "outline" && "border-border",
        variant === "secondary" && "border-border bg-surface",
        className
      )}
    />
  );
}

function Panel({ className, ...props }: ComponentProps<typeof Card>) {
  return (
    <Card
      {...props}
      className={twMerge("rounded-md border border-border bg-surface p-6 shadow-none", className)}
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
