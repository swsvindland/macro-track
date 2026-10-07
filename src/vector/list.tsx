import {
  isValidElement,
  useContext,
  useImperativeHandle,
  useRef,
  type ReactElement,
  type ReactNode,
  type Ref,
} from "react";
import {
  Platform,
  Pressable,
  View,
  useWindowDimensions,
  type AccessibilityActionEvent,
  type AccessibilityActionInfo,
  type AccessibilityState,
  type ViewStyle,
} from "react-native";
import ReanimatedSwipeable, {
  SwipeDirection,
  type SwipeableMethods,
} from "react-native-gesture-handler/ReanimatedSwipeable";
import { SafeAreaInsetsContext } from "react-native-safe-area-context";
import { Menu } from "heroui-native";
import { twMerge } from "tailwind-merge";
import { IconButton } from "./button";
import { Toggle } from "./form";
import { isMonoSafe } from "./format";
import { Icon } from "./icon";
import type { IconName } from "./icons";
import { Panel, useRowIndex } from "./panel";
import {
  KitScope,
  useEditorPortalHost,
  useHaptics,
  useKit,
  webA11y,
  webHeading,
  webHidden,
} from "./provider";
import { Label, Text } from "./text";

/**
 * 1pt separator above every row but the first in a row panel; inset 16, or 48 past a leading icon. App rows
 * inside `Panel inset="none"` draw it first too, so they rule like ListRow; `visible` overrides the position
 * for rows nested below a panel child (a group under its own header).
 */
export function RowRule({ icon, visible }: { icon?: boolean; visible?: boolean }) {
  const index = useRowIndex();
  if (!(visible ?? !!index)) return null;
  return <View className={twMerge("h-px bg-separator", icon ? "ms-12" : "ms-4")} />;
}

const web = Platform.OS === "web";
const noPointer: ViewStyle = { pointerEvents: "none" };
/** Web: react-native-web's View ref is the DOM element; inert takes its subtree out of focus, pointer and AT. */
const makeInert = (node: View | null) => {
  if (node) (node as unknown as HTMLElement).inert = true;
};

/** Text runs get the row's small muted style; an element (a Meta, two lines) renders as given. */
const detail = (description: string | ReactElement | undefined) =>
  typeof description === "string" ? (
    <Text variant="small" tone="muted">
      {description}
    </Text>
  ) : (
    (description ?? null)
  );

/** Only the keys that apply, so a plain row reports no state at all. */
const stateOf = (s: AccessibilityState) => {
  const set = Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined));
  return Object.keys(set).length ? (set as AccessibilityState) : undefined;
};

/** The marks ListRow draws at its end itself. */
export type ListRowTrailing = "chevron" | "check" | "toggle" | "none";
/** Any other end node, text included; the intersection keeps `string` from swallowing the four marks. */
type TrailingNode = ReactNode & Record<never, never>;

export type ListRowProps = {
  title: string;
  /** A string reads as small muted; an element (a Meta, a second line) renders as given. */
  description?: string | ReactElement;
  icon?: IconName;
  /** Data (mono-safe) reads as readoutS muted; words as small muted. An element renders as given. */
  value?: string | ReactElement;
  /**
   * Default: a `forward` chevron when the row navigates (onPress, not destructive), else nothing. A node here
   * is decoration read with the row; an interactive control goes in `control`.
   */
  trailing?: ListRowTrailing | TrailingNode | null;
  /**
   * An interactive control at the end (Button, IconButton, ActionMenu, Toggle). It stays its own touch target
   * and screen-reader element: the row's text becomes a separate element beside it, and `onPress` covers the
   * text only. Replaces `trailing`. Pass `disabled` to the control yourself.
   */
  control?: ReactNode;
  onPress?: () => void;
  destructive?: boolean;
  /** Dims the row, blocks the press and the toggle, and reports disabled to screen readers. */
  disabled?: boolean;
  toggleValue?: boolean;
  onToggle?: (value: boolean) => void;
  accessibilityLabel?: string;
  /** What activating does, e.g. "Edits Push day", when the title alone doesn't say. */
  accessibilityHint?: string;
  /** Every row action also exists here (and in the ActionMenu), for screen readers. */
  accessibilityActions?: AccessibilityActionInfo[];
  onAccessibilityAction?: (event: AccessibilityActionEvent) => void;
};

/**
 * The settings and list row: 44 min (56 with a description), px-4 py-3, gap 12. With `trailing="toggle"` the
 * whole row is the switch target and the one accessible element. Stacks the value under the title at
 * accessibility text sizes.
 */
export function ListRow({
  title,
  description,
  icon,
  value,
  trailing,
  control,
  onPress,
  destructive = false,
  disabled = false,
  toggleValue = false,
  onToggle,
  accessibilityLabel,
  accessibilityHint,
  accessibilityActions,
  onAccessibilityAction,
}: ListRowProps) {
  const { largeType } = useKit();
  const haptics = useHaptics();
  const hasControl = control != null;
  const toggle = !hasControl && trailing === "toggle";
  const end = hasControl ? "none" : (trailing ?? (onPress && !destructive ? "chevron" : "none"));
  const valueNode =
    typeof value === "string" ? (
      <Text variant={isMonoSafe(value) ? "readoutS" : "small"} tone="muted">
        {value}
      </Text>
    ) : (
      (value ?? null)
    );
  const trailingNode =
    end === "chevron" ? (
      <Icon name="forward" size={17} tone="muted" />
    ) : end === "check" ? (
      <Icon name="check" size={17} tone="tint" />
    ) : toggle ? (
      // The row carries the switch semantics; the native switch stays tappable but is not a second stop. On web
      // the switch is only drawn: react-native-web's is a focusable checkbox input, so it is inert (no tab stop
      // under aria-hidden) and lets the click through to the row (whose press would otherwise toggle it twice).
      <View
        importantForAccessibility="no-hide-descendants"
        accessibilityElementsHidden
        {...webHidden}
        ref={web ? makeInert : undefined}
        style={web ? noPointer : undefined}
      >
        <Toggle
          value={toggleValue}
          onChange={(v) => onToggle?.(v)}
          accessibilityLabel={title}
          disabled={disabled}
        />
      </View>
    ) : end === "none" ? null : (
      end
    );
  const press = toggle
    ? () => {
        haptics.selection();
        onToggle?.(!toggleValue);
      }
    : onPress;
  const body = (
    <>
      {/* Dimmed as one block; a native switch dims itself, so the toggle stays outside. */}
      <View
        className={twMerge("flex-1 flex-row items-center gap-3", disabled && "opacity-disabled")}
      >
        {icon ? <Icon name={icon} tone={destructive ? "danger" : "muted"} /> : null}
        <View
          className={twMerge(
            "flex-1 gap-0.5",
            !largeType && valueNode && "flex-row flex-wrap items-center justify-between gap-x-3"
          )}
        >
          <View className={largeType || !valueNode ? "" : "shrink"}>
            <Text
              variant={description ? "body" : "bodyStrong"}
              tone={destructive ? "danger" : "default"}
            >
              {title}
            </Text>
            {detail(description)}
          </View>
          {valueNode}
        </View>
        {toggle ? null : trailingNode}
      </View>
      {toggle ? trailingNode : null}
    </>
  );
  const state = stateOf({
    checked: toggle ? toggleValue : undefined,
    // A check row is the current choice: say so, not only show it (selected; aria-current on web).
    selected: end === "check" ? true : undefined,
    disabled: disabled || undefined,
  });
  const a11y = {
    accessibilityLabel,
    accessibilityHint,
    accessibilityActions,
    onAccessibilityAction,
    accessibilityState: state,
    ...webA11y(state),
  };
  // With a control the text area gives up its end padding to the control's own slot.
  const row = twMerge(
    "flex-row items-center gap-3 py-3 ps-4",
    hasControl ? "flex-1 pe-3" : "pe-4",
    description ? "min-h-14" : "min-h-11"
  );
  const main = press ? (
    <Pressable
      {...a11y}
      accessibilityRole={toggle ? "switch" : "button"}
      disabled={disabled}
      onPress={press}
      className={twMerge(row, "active:bg-surface-secondary")}
    >
      {body}
    </Pressable>
  ) : (
    <View accessible {...a11y} className={row}>
      {body}
    </View>
  );
  return (
    <>
      <RowRule icon={!!icon} />
      {hasControl ? (
        // Siblings, not nested: an accessible row would swallow the control for VoiceOver.
        <View className="flex-row items-center">
          {main}
          <View className="pe-4">{control}</View>
        </View>
      ) : (
        main
      )}
    </>
  );
}

/** The one settings anatomy for all four apps: Label eyebrow, a row panel, an optional caption footnote. */
export function SettingsSection({
  eyebrow,
  footnote,
  children,
}: {
  eyebrow: string;
  footnote?: string;
  children: ReactNode;
}) {
  return (
    <View className="gap-2">
      {/* The section title (it replaces lift's heading-style labels), so it is a rotor heading. */}
      <Label accessibilityRole="header" {...webHeading(2)}>
        {eyebrow}
      </Label>
      <Panel inset="none">{children}</Panel>
      {footnote ? (
        <Text variant="caption" tone="muted">
          {footnote}
        </Text>
      ) : null}
    </View>
  );
}

export type RecordRowProps = {
  /** Already formatted (format.time). */
  time: string;
  title: string;
  /** A string reads as small muted; an element (a Meta of facets) renders as given. */
  description?: string | ReactElement;
  value: ReactElement;
  /** Before the time column: a glyph (IconName, 20 muted) or an element such as a selection mark. */
  leading?: IconName | ReactElement;
  /** An interactive control after the value (an ActionMenu), kept its own screen-reader element. */
  control?: ReactNode;
  onPress?: () => void;
  /** e.g. macro's diary: a long press starts choosing several rows. */
  onLongPress?: () => void;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  /** e.g. `{ selected }` while choosing rows. */
  accessibilityState?: AccessibilityState;
  accessibilityActions?: AccessibilityActionInfo[];
  onAccessibilityAction?: (event: AccessibilityActionEvent) => void;
};

/**
 * History row (water drinks, measurements, lift sets, macro timeline): a 56pt start column with the time,
 * then title and description, then the value (`Value s`) at the end. Edit and delete go through SwipeRow,
 * these accessibilityActions and the ActionMenu (`control`).
 */
export function RecordRow({
  time,
  title,
  description,
  value,
  leading,
  control,
  onPress,
  onLongPress,
  accessibilityLabel,
  accessibilityHint,
  accessibilityState,
  accessibilityActions,
  onAccessibilityAction,
}: RecordRowProps) {
  const hasControl = control != null;
  const body = (
    <>
      {typeof leading === "string" ? <Icon name={leading} tone="muted" /> : (leading ?? null)}
      <View className="min-w-14">
        <Text variant="readoutXS" tone="muted">
          {time}
        </Text>
      </View>
      <View className="flex-1 gap-0.5">
        <Text>{title}</Text>
        {detail(description)}
      </View>
      {value}
    </>
  );
  const row = twMerge(
    "min-h-14 flex-row items-center gap-3 py-3 ps-4",
    hasControl ? "flex-1 pe-1" : "pe-4"
  );
  const pressable = !!(onPress || onLongPress);
  const a11y = {
    accessibilityLabel,
    accessibilityHint,
    accessibilityState,
    accessibilityActions,
    onAccessibilityAction,
    // A pressable row that is selected while choosing rows is a toggle on web; a static one is the current item.
    ...webA11y(accessibilityState, null, pressable ? "pressed" : "current"),
  };
  const main = pressable ? (
    <Pressable
      accessibilityRole="button"
      {...a11y}
      onPress={onPress}
      onLongPress={onLongPress}
      className={twMerge(row, "active:bg-surface-secondary")}
    >
      {body}
    </Pressable>
  ) : (
    <View accessible {...a11y} className={row}>
      {body}
    </View>
  );
  return (
    <>
      <RowRule />
      {hasControl ? (
        // Siblings, not nested: an accessible row would swallow the menu for VoiceOver.
        <View className="flex-row items-center">
          {main}
          <View className="pe-1">{control}</View>
        </View>
      ) : (
        main
      )}
    </>
  );
}

export type SwipeAction = {
  label: string;
  icon: IconName;
  /**
   * Runs as the swipe commits. A destructive row stays open, expecting to disappear: call `close` when it
   * doesn't (a cancelled confirm), so it springs back.
   */
  onAction: (close: () => void) => void;
  destructive?: boolean;
};

/** SwipeRow's `ref`: springs the row back, e.g. after a delete confirm is cancelled. */
export type SwipeRowHandle = { close: () => void };

const SWIPE_THRESHOLD = 72;

/**
 * A row with an action on each swipe, in logical terms: `leadingAction` sits at the start edge (revealed by
 * swiping toward the end), `trailingAction` at the end edge (revealed by swiping toward the start); both flip
 * under RTL. The action runs as soon as the swipe passes 72pt (commit haptic), so a destructive one should offer
 * Undo. Screen readers need the same actions as accessibilityActions on the row itself.
 */
export function SwipeRow({
  leadingAction,
  trailingAction,
  enabled = true,
  ref,
  children,
}: {
  leadingAction?: SwipeAction;
  trailingAction?: SwipeAction;
  enabled?: boolean;
  ref?: Ref<SwipeRowHandle>;
  children: ReactNode;
}) {
  const swipeable = useRef<SwipeableMethods>(null);
  const close = () => swipeable.current?.close();
  useImperativeHandle(ref, () => ({ close: () => swipeable.current?.close() }), []);
  const { isRTL } = useKit();
  const haptics = useHaptics();
  // Gesture Handler's left/right are physical; start is the right edge in RTL.
  const left = isRTL ? trailingAction : leadingAction;
  const right = isRTL ? leadingAction : trailingAction;
  const panel = (action: SwipeAction, edge: "start" | "end") => (
    <View
      className={twMerge(
        "w-24 justify-center gap-1 px-4",
        edge === "start" ? "items-start" : "items-end",
        action.destructive ? "bg-danger" : "bg-surface-tertiary"
      )}
    >
      <Icon name={action.icon} tone={action.destructive ? "onDanger" : "foreground"} />
      <Text
        variant="caption"
        className={action.destructive ? "text-danger-foreground" : undefined}
        numberOfLines={1}
      >
        {action.label}
      </Text>
    </View>
  );
  // The panel on the physical left is the start edge in LTR and the end edge in RTL.
  const leftEdge = isRTL ? "end" : "start";
  const rightEdge = isRTL ? "start" : "end";
  return (
    <ReanimatedSwipeable
      ref={swipeable}
      enabled={enabled}
      friction={1.5}
      leftThreshold={SWIPE_THRESHOLD}
      rightThreshold={SWIPE_THRESHOLD}
      renderLeftActions={left && (() => panel(left, leftEdge))}
      renderRightActions={right && (() => panel(right, rightEdge))}
      onSwipeableWillOpen={(direction) => {
        // Swiping right reveals the left panel.
        const action = direction === SwipeDirection.RIGHT ? left : right;
        if (!action) return;
        haptics.commit();
        // A destructive action removes the row; anything else springs back.
        if (!action.destructive) close();
        action.onAction(close);
      }}
    >
      <View className="bg-surface">{children}</View>
    </ReanimatedSwipeable>
  );
}

export type MenuAction = {
  key: string;
  label: string;
  icon?: IconName;
  onPress: () => void;
  disabled?: boolean;
  /** Shows a tint check: the current choice in a single-select section. */
  selected?: boolean;
  destructive?: boolean;
};

/**
 * Secondary actions behind one `···` trigger: a HeroUI Menu popover (bottom, aligned to the end edge, so it is
 * RTL-safe), 44pt items, leading glyph 17 muted, destructive items last in danger. Width fits the longest label,
 * clamped to 200…min(320, window − 32 − side safe areas); a label past the cap wraps inside the popover.
 */
export function ActionMenu({
  accessibilityLabel,
  sections,
  trigger,
}: {
  accessibilityLabel: string;
  sections: { title?: string; actions: MenuAction[] }[];
  /** Custom trigger content (must accept onPress and a ref); defaults to a ghost `more` IconButton. */
  trigger?: ReactNode;
}) {
  const kit = useKit();
  const { width } = useWindowDimensions();
  // Not useSafeAreaInsets: it throws without a SafeAreaProvider, and a closed menu must not need one (component
  // tests render rows without it).
  const safe = useContext(SafeAreaInsetsContext) ?? { top: 0, bottom: 0, left: 0, right: 0 };
  const host = useEditorPortalHost();
  const custom = isValidElement(trigger);
  // `insets` replaces HeroUI's own (12 + the safe area), so the safe area is added back here.
  const insets = {
    top: safe.top + 16,
    bottom: safe.bottom + 16,
    left: safe.left + 16,
    right: safe.right + 16,
  };
  const room = width - insets.left - insets.right;
  const maxWidth = Math.min(320, room);
  return (
    <Menu>
      <Menu.Trigger asChild accessibilityLabel={custom ? accessibilityLabel : undefined}>
        {custom ? (
          trigger
        ) : (
          // Menu.Trigger (asChild) supplies onPress and the ref it measures.
          <IconButton icon="more" accessibilityLabel={accessibilityLabel} onPress={() => {}} />
        )}
      </Menu.Trigger>
      <Menu.Portal
        hostName={host}
        disableFullWindowOverlay={host !== undefined}
        unstable_accessibilityContainerViewIsModal
      >
        <KitScope value={kit}>
          <Menu.Overlay />
          <Menu.Content
            presentation="popover"
            placement="bottom"
            align="end"
            width="content-fit"
            insets={insets}
            className="rounded-control border border-border bg-overlay p-1"
            // The list below owns the inline padding, so every number in its cap is the kit's. Inline, because
            // HeroUI's unlayered .menu__content beats a utility class on web.
            style={{ minWidth: Math.min(200, room), maxWidth, paddingInline: 0 }}
          >
            {/* Yoga measures the content-fit popover with no width bound and keeps that pass's height, so the
                cap sits here too (less the 1pt border): a label past it wraps while measured, and the frame
                includes the extra line. */}
            <View className="px-1.5" style={{ maxWidth: maxWidth - 2 }}>
              {sections.map((section, i) => (
                <View
                  key={section.title ?? i}
                  className={i ? "mt-1 border-t border-separator pt-1" : undefined}
                >
                  {section.title ? <Label className="px-3 pb-1 pt-2">{section.title}</Label> : null}
                  {[...section.actions]
                    .sort((a, b) => Number(!!a.destructive) - Number(!!b.destructive))
                    .map((action) => (
                      <Menu.Item
                        key={action.key}
                        isDisabled={action.disabled}
                        variant={action.destructive ? "danger" : "default"}
                        accessibilityState={{
                          disabled: action.disabled,
                          ...(action.selected !== undefined ? { selected: action.selected } : {}),
                        }}
                        // The current choice of its section: aria-current on web.
                        {...webA11y({ disabled: action.disabled, selected: action.selected })}
                        onPress={action.onPress}
                        className="gap-3 px-3"
                      >
                        {action.icon ? (
                          <Icon
                            name={action.icon}
                            size={17}
                            tone={action.destructive ? "danger" : "muted"}
                          />
                        ) : null}
                        {/* flex -1 is 0 1 auto: the label sizes its row. HeroUI's flex: 1 made the basis 0
                            (Yoga drops basis auto while flex > 0), so every menu measured at its minimum. It
                            must not grow either: RN's Yoga errata stretch a growing row to the cap. */}
                        <Menu.ItemTitle style={{ flex: -1 }}>{action.label}</Menu.ItemTitle>
                        {action.selected ? (
                          // The title doesn't grow, so the check takes the free space to the end edge.
                          <View className="ms-auto">
                            <Icon name="check" size={17} tone="tint" />
                          </View>
                        ) : null}
                      </Menu.Item>
                    ))}
                </View>
              ))}
            </View>
          </Menu.Content>
        </KitScope>
      </Menu.Portal>
    </Menu>
  );
}
