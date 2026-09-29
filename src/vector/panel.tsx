import { Children, createContext, isValidElement, useContext, type ReactNode } from "react";
import { Pressable, View, useWindowDimensions } from "react-native";
import { twMerge } from "tailwind-merge";
import { useKit } from "./provider";
import { Heading, Label, Note, Text } from "./text";

type PanelTone = "default" | "live" | "critical";
type PanelContext = { pad: number; tone: PanelTone; rows: boolean };
const PanelCtx = createContext<PanelContext>({ pad: 16, tone: "default", rows: false });

/**
 * Position of a row inside `Panel inset="none"`: ListRow and RecordRow draw their top separator when > 0, so
 * lists never end on a stray rule. undefined outside a row panel. Rows must be direct children of the Panel;
 * a Panel.Header is not counted (its own full-bleed rule already sits above the first row). App rows use it
 * through `RowRule` (list.tsx).
 */
const RowIndex = createContext<number | undefined>(undefined);
export const useRowIndex = () => useContext(RowIndex);

export type PanelProps = {
  /** live: 3pt signal start rule (a fill, §2.4). critical: danger border and danger eyebrow. */
  tone?: PanelTone;
  /** none: no padding, for row lists (ListRow, RecordRow). */
  inset?: "md" | "none";
  onPress?: () => void;
  accessibilityLabel?: string;
  /** What pressing does, e.g. "Edits your program" (pressable panels). */
  accessibilityHint?: string;
  /** Layout only: margin, flex, self-alignment. */
  className?: string;
  children: ReactNode;
};

/** White on white, separated by a 1pt border. No shadow, no tinted or "hero" panels. */
function PanelRoot({
  tone = "default",
  inset = "md",
  onPress,
  accessibilityLabel,
  accessibilityHint,
  className,
  children,
}: PanelProps) {
  const { width } = useWindowDimensions();
  const rows = inset === "none";
  const pad = rows ? 0 : width >= 600 ? 24 : 16;
  const classes = twMerge(
    "overflow-hidden rounded-panel border bg-surface",
    tone === "critical" ? "border-danger" : "border-border",
    rows ? "" : pad === 24 ? "gap-3 p-6" : "gap-3 p-4",
    onPress && "active:bg-surface-secondary",
    className
  );
  let row = 0;
  const content = rows
    ? Children.toArray(children).map((child, i) => (
        <RowIndex.Provider
          key={isValidElement(child) && child.key != null ? child.key : i}
          value={isPanelHeader(child) ? undefined : row++}
        >
          {child}
        </RowIndex.Provider>
      ))
    : children;
  const body = (
    <PanelCtx.Provider value={{ pad, tone, rows }}>
      {tone === "live" ? (
        <View
          className="absolute inset-y-0 start-0 w-[3px] bg-accent"
          importantForAccessibility="no"
        />
      ) : null}
      {content}
    </PanelCtx.Provider>
  );
  if (onPress) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityHint={accessibilityHint}
        onPress={onPress}
        className={classes}
      >
        {body}
      </Pressable>
    );
  }
  return (
    <View className={classes} accessibilityLabel={accessibilityLabel}>
      {body}
    </View>
  );
}

/** Eyebrow at start, meta (readoutXS muted) at end, over a full-bleed 1pt separator. Stacks at large type. */
function PanelHeader({
  eyebrow,
  meta,
  title,
  action,
  wrap = false,
}: {
  eyebrow?: string;
  meta?: ReactNode;
  title?: string;
  /**
   * One 44pt IconButton or ActionMenu at the end of the eyebrow row. It bleeds into the panel padding, so the
   * header keeps its text height and the glyph lines up with the content edge.
   */
  action?: ReactNode;
  /** Let a long eyebrow wrap (de "SCHULTERN / TAILLE" in a narrow tile) instead of ending in an ellipsis. */
  wrap?: boolean;
}) {
  const { pad, tone, rows } = useContext(PanelCtx);
  const { largeType } = useKit();
  const line =
    eyebrow || meta != null ? (
      <View
        className={twMerge(
          largeType ? "items-start gap-1" : "flex-row items-center justify-between gap-3",
          action != null && "flex-1"
        )}
      >
        {eyebrow ? (
          // Without a title the eyebrow names the panel, so VoiceOver's heading rotor stops on it.
          <Label
            tone={tone === "critical" ? "danger" : "muted"}
            accessibilityRole={title ? undefined : "header"}
            numberOfLines={wrap ? 0 : 1}
            className="shrink"
          >
            {eyebrow}
          </Label>
        ) : null}
        {typeof meta === "string" ? (
          <Text variant="readoutXS" tone="muted">
            {meta}
          </Text>
        ) : (
          meta
        )}
      </View>
    ) : null;
  return (
    <View className={twMerge("gap-2", rows && "px-4 pt-3")}>
      {action != null ? (
        <View className="flex-row items-center gap-3">
          {line ?? <View className="flex-1" />}
          {/* -my-3 -me-3: the 44pt target overhangs into the padding instead of growing the row. */}
          <View className="-my-3 -me-3">{action}</View>
        </View>
      ) : (
        line
      )}
      {title ? <Heading level={3}>{title}</Heading> : null}
      {/* Full bleed: the rule runs under the panel padding to both edges (symmetric, so RTL-neutral). */}
      <View className="mt-1 h-px bg-separator" style={{ marginHorizontal: rows ? -16 : -pad }} />
    </View>
  );
}

// Marks Panel.Header for row numbering. A migration shim that wraps Panel.Header copies it onto its own
// component (`ShimHeader.panelHeader = true`) so its header is not counted as a row either.
PanelHeader.panelHeader = true as const;
const isPanelHeader = (child: ReactNode) =>
  isValidElement(child) && (child.type as { panelHeader?: boolean }).panelHeader === true;

const PanelTitle = ({ children }: { children: string }) => <Heading level={3}>{children}</Heading>;

const PanelDescription = ({ children }: { children: ReactNode }) => <Note>{children}</Note>;

const PanelBody = ({ children, className }: { children: ReactNode; className?: string }) => (
  <View className={twMerge("gap-3", className)}>{children}</View>
);

const PanelFooter = ({ children }: { children: ReactNode }) => (
  <View className="flex-row flex-wrap items-center gap-2">{children}</View>
);

/** `bg-surface border border-border rounded-panel p-4 gap-3`, with compound slots. Always use `.Body`. */
export const Panel = Object.assign(PanelRoot, {
  Header: PanelHeader,
  Title: PanelTitle,
  Description: PanelDescription,
  Body: PanelBody,
  Footer: PanelFooter,
});
