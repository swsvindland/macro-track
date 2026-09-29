import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type Ref,
} from "react";
import {
  AccessibilityInfo,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  View,
  useWindowDimensions,
  type RefreshControlProps,
} from "react-native";
import {
  SafeAreaView as NativeSafeAreaView,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
import {
  Stack,
  ThemeProvider,
  useFocusEffect,
  useIsFocused,
  type NativeStackNavigationOptions,
} from "expo-router";
import { useToast } from "heroui-native";
import { twMerge } from "tailwind-merge";
import { withUniwind } from "uniwind";
import { IconButton, LinkButton, OnSignalProvider } from "./button";
import { SystemState } from "./feedback";
import { icons, type IconName } from "./icons";
import { ActionMenu, type MenuAction } from "./list";
import { detailHeaderOptions, isLiquidGlass, navigationTheme } from "./native";
import { SignalBudget, useHaptics, useKit, useKitStrings } from "./provider";
import { Heading, Label, Note, Text } from "./text";
import { light } from "./tokens";

// Third-party native views need a Uniwind adapter for className styles.
const SafeAreaView = withUniwind(NativeSafeAreaView);

const UNDO_MS = 6000;
const widths = { form: 640, data: 1040 } as const;
/** Screen gutter: 16 below 600pt, 24 to 1023, 32 from 1024 (design-system §4.1). */
const gutterFor = (width: number) => (width < 600 ? 16 : width < 1024 ? 24 : 32);

type Undo = {
  key: number;
  message: string;
  onUndo: () => void;
  durationMs: number;
  undoneMessage?: string;
};
type DockState = { node: ReactNode; undo: Undo | null };
type DockApi = {
  set: (owner: string, node: ReactNode) => void;
  clear: (owner: string) => void;
  showUndo: (undo: Omit<Undo, "key">) => void;
  dismissUndo: () => void;
};
// Split so a screen that registers dock content (useDock) never re-renders when the dock changes.
const DockStateCtx = createContext<DockState | null>(null);
const DockApiCtx = createContext<DockApi | null>(null);

/**
 * VoiceOver / TalkBack state, kept live: Undo must not time out while a screen reader is reaching it. Apps use
 * it for the same kind of rule (hold a transient message, skip an auto-advance).
 */
export function useScreenReader() {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let live = true;
    AccessibilityInfo.isScreenReaderEnabled()
      .then((v) => live && setOn(v))
      .catch(() => {});
    const sub = AccessibilityInfo.addEventListener("screenReaderChanged", setOn);
    return () => {
      live = false;
      sub.remove();
    };
  }, []);
  return on;
}

/** Spoken on both platforms: the docked Undo strip is not a live region of its own. */
const announce = (message: string) => AccessibilityInfo.announceForAccessibility(message);

/**
 * Wraps (tabs)/_layout, or the root Stack so pushed screens get the docked Undo too: holds the Dock (tab-screen
 * tools registered with useDock by the focused tab) and the Undo strip that stacks above it (only the focused
 * Screen draws either). Replaces lift/macro's `ScreenFooter` context.
 */
export function DockProvider({ children }: { children: ReactNode }) {
  const [dock, setDock] = useState<{ owner: string | null; node: ReactNode }>({
    owner: null,
    node: null,
  });
  const [undo, setUndo] = useState<Undo | null>(null);
  const seq = useRef(0);
  const reading = useScreenReader();
  const api = useMemo<DockApi>(
    () => ({
      set: (owner, node) => setDock({ owner, node }),
      // Tab switches can run the new tab's focus before the old tab's blur: only the owner may clear.
      clear: (owner) => setDock((d) => (d.owner === owner ? { owner: null, node: null } : d)),
      // A new show replaces the previous one, which makes that action final.
      showUndo: (next) => setUndo({ ...next, key: ++seq.current }),
      dismissUndo: () => setUndo(null),
    }),
    []
  );
  useEffect(() => {
    if (!undo) return;
    announce(undo.message);
    // Screen-reader users need time to reach Undo, so it stays until the next action.
    if (reading) return;
    const id = setTimeout(() => setUndo((u) => (u?.key === undo.key ? null : u)), undo.durationMs);
    return () => clearTimeout(id);
  }, [undo, reading]);
  const state = useMemo(() => ({ node: dock.node, undo }), [dock.node, undo]);
  return (
    <DockApiCtx.Provider value={api}>
      <DockStateCtx.Provider value={state}>{children}</DockStateCtx.Provider>
    </DockApiCtx.Provider>
  );
}

/**
 * Registers this tab's tools (macro quick log, lift start) in the docked strip while the tab is focused;
 * cleared on blur. No-op outside a DockProvider.
 */
export function useDock(node: ReactNode | null) {
  const api = useContext(DockApiCtx);
  const owner = useId();
  useFocusEffect(
    useCallback(() => {
      if (!api) return;
      api.set(owner, node);
      return () => api.clear(owner);
    }, [api, owner, node])
  );
}

/**
 * Undo instead of confirm. Inside a DockProvider the strip stacks above the dock or footer for 6s (it stays
 * while a screen reader runs), so live controls never disappear; elsewhere it falls back to a HeroUI Toast at
 * the top edge, clear of the tab bar, footers and the keyboard. Announced on both platforms either way (the
 * toast is a live region on Android, so only iOS needs the explicit announcement there).
 */
export function useUndo(): {
  show: (o: {
    message: string;
    onUndo: () => void;
    durationMs?: number;
    /** Spoken (not shown) once Undo runs, e.g. "Log undone". */
    undoneMessage?: string;
  }) => void;
  dismiss: () => void;
} {
  const api = useContext(DockApiCtx);
  const { toast } = useToast();
  const strings = useKitStrings();
  const haptics = useHaptics();
  const reading = useScreenReader();
  const toastId = useRef<string | null>(null);
  return useMemo(
    () => ({
      show({ message, onUndo, durationMs = UNDO_MS, undoneMessage }) {
        if (api) {
          api.showUndo({ message, onUndo, durationMs, undoneMessage });
          return;
        }
        if (toastId.current) toast.hide(toastId.current);
        // HeroUI's toast root is role="status" aria-live="polite": an Android live region already reads it.
        if (Platform.OS === "ios") announce(message);
        toastId.current = toast.show({
          label: message,
          actionLabel: strings.undo,
          // The root toast host knows nothing of the tab bar or a docked footer; the top edge is always clear.
          placement: "top",
          duration: reading ? "persistent" : durationMs,
          onActionPress: ({ hide }) => {
            hide();
            haptics.selection();
            onUndo();
            if (undoneMessage) announce(undoneMessage);
          },
        });
      },
      dismiss() {
        if (api) api.dismissUndo();
        else if (toastId.current) toast.hide(toastId.current);
      },
    }),
    [api, toast, strings.undo, haptics, reading]
  );
}

/**
 * Docked, non-floating bar: surface, 1pt top border, content max 560. One lg primary (plus an optional ghost at
 * start). `live` is a full-bleed signal strip with signal-ink content, e.g. REST 01:32 + Skip; one at a time.
 */
export function ScreenFooter({
  tone = "default",
  children,
}: {
  tone?: "default" | "live";
  children: ReactNode;
}) {
  const live = tone === "live";
  return (
    <OnSignalProvider value={live}>
      <View
        className={twMerge(
          "min-h-14 justify-center px-4 py-2",
          live ? "bg-accent" : "border-t border-border bg-surface"
        )}
      >
        <View className="w-full max-w-[560px] flex-row items-center gap-3 self-center">
          {children}
        </View>
      </View>
    </OnSignalProvider>
  );
}

/** The docked Undo: a default ScreenFooter stacked above the dock or footer, never in its place. */
function UndoStrip({ undo }: { undo: Undo }) {
  const api = useContext(DockApiCtx);
  const strings = useKitStrings();
  const haptics = useHaptics();
  return (
    <ScreenFooter>
      {/* Announced by the provider on both platforms, so not a live region too (TalkBack would say it twice). */}
      <Text variant="small" className="flex-1" numberOfLines={2}>
        {undo.message}
      </Text>
      <LinkButton
        onPress={() => {
          // Dismiss first: a double tap must not undo twice.
          api?.dismissUndo();
          haptics.selection();
          undo.onUndo();
          if (undo.undoneMessage) announce(undo.undoneMessage);
        }}
      >
        {strings.undo}
      </LinkButton>
    </ScreenFooter>
  );
}

export type ScreenProps = {
  title: string;
  /** Live context in mono (the date on Today, the range on Progress), never a restatement of the title. */
  eyebrow?: string;
  subtitle?: string;
  /** One trailing action. */
  action?: ReactNode;
  /** Replaces the in-content title with a sticky row inside the ScrollView (macro week strip). */
  header?: ReactNode;
  /** Docked above the tab bar (not floating); usually a ScreenFooter. Undo stacks above it for 6s. */
  footer?: ReactNode;
  /** form 640 (settings, editors) · data 1040 (dashboards, history; default). */
  width?: "form" | "data";
  /**
   * false: a static column (water Today at normal text sizes). It fills the height left under the title, so a
   * child with `flex-1` takes the rest (min-height 0: it shrinks instead of pushing the dock off screen).
   */
  scroll?: boolean;
  /** Pushed screens: the native bar carries the title (use DetailScreen). */
  nativeHeader?: boolean;
  compact?: boolean;
  /** Skeleton rows after 300ms instead of the children. */
  loading?: boolean;
  scrollRef?: Ref<ScrollView>;
  refreshControl?: ReactElement<RefreshControlProps>;
  children: ReactNode;
};

/**
 * Tab roots and pushed screens. The ScrollView is the first descendant (iOS 26 scroll-edge detection needs it),
 * with automatic content insets, so the Liquid Glass tab bar and header are never painted over.
 */
export function Screen({
  title,
  eyebrow,
  subtitle,
  action,
  header,
  footer,
  width = "data",
  scroll = true,
  nativeHeader = false,
  compact = false,
  loading = false,
  scrollRef,
  refreshControl,
  children,
}: ScreenProps) {
  const { width: window } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const { flags } = useKit();
  const dock = useContext(DockStateCtx);
  // Every visited tab stays mounted: only the focused one draws the shared dock and undo strip, so a hidden
  // tab never counts the dock's primary against its own signal budget.
  const focused = useIsFocused();
  const gutter = gutterFor(window);
  const docked = footer ?? (focused ? dock?.node : null) ?? null;
  const undo = (focused && dock?.undo) || null;
  // On iOS the tab bar floats over the screen and is part of its bottom safe area, so a docked bar on a tab
  // root sits that far up. Pushed screens pad the bottom edge through the SafeAreaView; Android's bar is outside.
  const dockInset = !nativeHeader && Platform.OS === "ios" ? insets.bottom : 0;
  // A static column has no automatic scroll inset, so without a dock it clears the floating tab bar itself.
  const staticInset = docked || undo ? 0 : dockInset;
  const column = {
    padding: gutter,
    paddingTop: header ? 8 : compact ? 12 : 16,
    paddingBottom: docked || undo ? 24 : 32,
    gap: compact ? 16 : 24,
    width: "100%" as const,
    maxWidth: widths[width] + gutter * 2,
    alignSelf: "center" as const,
    ...(scroll ? null : { flex: 1, minHeight: 0 }),
  };
  const content = (
    <View style={column}>
      {!nativeHeader && !header ? (
        <View>
          {eyebrow ? <Label className="mb-2">{eyebrow}</Label> : null}
          <View className="flex-row items-center gap-3">
            <Heading level={1} className="flex-1">
              {title}
            </Heading>
            {action}
          </View>
          {subtitle ? <Note className="mt-1">{subtitle}</Note> : null}
          <View className="mt-4 h-px bg-border" />
        </View>
      ) : null}
      {loading ? <SystemState kind="loading" /> : children}
    </View>
  );
  const screen = (
    <SignalBudget name="screen">
      <SafeAreaView
        className="flex-1 bg-background"
        edges={
          nativeHeader
            ? ["bottom", "left", "right"]
            : // Only a ScrollView can run under the status bar; a static column always clears it.
              flags.scrollUnderStatusBar && scroll
              ? ["left", "right"]
              : ["top"]
        }
      >
        {scroll ? (
          <ScrollView
            ref={scrollRef}
            className="flex-1"
            contentInsetAdjustmentBehavior="automatic"
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            automaticallyAdjustKeyboardInsets
            stickyHeaderIndices={header ? [0] : undefined}
            refreshControl={refreshControl}
          >
            {header ? (
              <View
                className="min-h-12 justify-center bg-background pt-2"
                style={{ paddingHorizontal: gutter }}
              >
                {header}
              </View>
            ) : null}
            {content}
          </ScrollView>
        ) : (
          <View className="flex-1" style={{ paddingBottom: staticInset }}>
            {header ? (
              <View className="min-h-12 justify-center pt-2" style={{ paddingHorizontal: gutter }}>
                {header}
              </View>
            ) : null}
            {content}
          </View>
        )}
        {docked || undo ? (
          <View style={{ paddingBottom: dockInset }}>
            {undo ? <UndoStrip key={undo.key} undo={undo} /> : null}
            {docked}
          </View>
        ) : null}
      </SafeAreaView>
    </SignalBudget>
  );
  // iOS insets the ScrollView for the keyboard natively (automaticallyAdjustKeyboardInsets). Android draws edge to
  // edge, so the window no longer resizes: the screen shrinks above the keyboard instead, dock included.
  return Platform.OS === "android" ? <KeyboardShrink>{screen}</KeyboardShrink> : screen;
}

/**
 * Android: shrinks its content above the keyboard. KeyboardAvoidingView compares its parent-relative frame with
 * the keyboard's screen position, so a pushed screen (below the native header) would stay covered by the header's
 * height; the measured window top is passed as the offset.
 */
function KeyboardShrink({ children }: { children: ReactNode }) {
  const frame = useRef<View>(null);
  const [top, setTop] = useState(0);
  return (
    <View
      ref={frame}
      style={{ flex: 1 }}
      onLayout={() => frame.current?.measureInWindow((_x, y) => setTop(Math.max(0, y)))}
    >
      <KeyboardAvoidingView behavior="height" keyboardVerticalOffset={top} style={{ flex: 1 }}>
        {children}
      </KeyboardAvoidingView>
    </View>
  );
}

/** An icon action in the native bar. `prominent` marks the screen's main action (e.g. Add). */
export type HeaderButton = {
  icon: IconName;
  accessibilityLabel: string;
  onPress: () => void;
  disabled?: boolean;
  /** iOS 26 with flag prominentHeaderItems: a `prominent` item filled with light-mode tint (never #22D3EE). */
  prominent?: boolean;
};
/** The overflow menu at the trailing edge; same sections as ActionMenu. */
export type HeaderMenu = {
  accessibilityLabel: string;
  sections: { title?: string; actions: MenuAction[] }[];
};

type HeaderItem = ReturnType<
  NonNullable<NativeStackNavigationOptions["unstable_headerRightItems"]>
>[number];
type HeaderIcon = Extract<HeaderItem, { type: "button" }>["icon"];
type SymbolName = Extract<NonNullable<HeaderIcon>, { type: "sfSymbol" }>["name"];

// The registry's SF names are plain strings; the header API types them as the SF Symbols union.
const symbol = (name: IconName): HeaderIcon => ({
  type: "sfSymbol",
  name: icons[name].sf as SymbolName,
});

function headerMenuItems(sections: HeaderMenu["sections"]) {
  const item = (a: MenuAction) => ({
    type: "action" as const,
    label: a.label,
    icon: a.icon ? symbol(a.icon) : undefined,
    onPress: a.onPress,
    disabled: a.disabled,
    destructive: a.destructive,
    state: a.selected ? ("on" as const) : undefined,
  });
  // Destructive items last, as in ActionMenu; titled sections become inline submenus (native separators).
  const sorted = (actions: MenuAction[]) =>
    [...actions].sort((a, b) => Number(!!a.destructive) - Number(!!b.destructive)).map(item);
  if (sections.length === 1 && !sections[0].title) return sorted(sections[0].actions);
  return sections.map((section) => ({
    type: "submenu" as const,
    label: section.title ?? "",
    inline: true,
    items: sorted(section.actions),
  }));
}

/**
 * Gives React Navigation the Vector palette. Wrap the root <Stack> in it (inside VectorAdapter), so every stack
 * default the app does not set — header bar, screen and modal backgrounds, title colour — follows the kit's scheme
 * instead of React Navigation's white and grey.
 */
export function NavigationTheme({ children }: { children: ReactNode }) {
  const { scheme } = useKit();
  const theme = useMemo(() => navigationTheme(scheme), [scheme]);
  return <ThemeProvider value={theme}>{children}</ThemeProvider>;
}

/**
 * A pushed screen: native bar with the system title (design-system §6.2), no in-content title. On iOS the
 * action and menu are native bar items (unstable_headerRightItems), so iOS 26 hosts them in its own glass;
 * a kit IconButton there would nest a 4pt rectangle inside the system capsule. Android keeps kit controls.
 */
export function DetailScreen({
  title,
  action,
  menu,
  scroll = true,
  footer,
  compact = false,
  children,
}: {
  title: string;
  /** At most one action, plus an optional overflow menu. */
  action?: HeaderButton;
  menu?: HeaderMenu;
  scroll?: boolean;
  /** Docked at the bottom edge (a ScreenFooter: lift's rest strip, a session preview's Start). */
  footer?: ReactNode;
  /** Tighter rhythm (16 gap, 12 top) for dense pushed screens such as the workout. */
  compact?: boolean;
  children: ReactNode;
}) {
  const { scheme, flags } = useKit();
  const items: NativeStackNavigationOptions = {};
  if (action || menu) {
    if (Platform.OS === "ios") {
      const prominent = !!action?.prominent && flags.prominentHeaderItems && isLiquidGlass;
      const list: HeaderItem[] = [];
      if (action)
        list.push({
          type: "button",
          label: action.accessibilityLabel,
          accessibilityLabel: action.accessibilityLabel,
          icon: symbol(action.icon),
          onPress: action.onPress,
          disabled: action.disabled,
          variant: prominent ? "prominent" : "plain",
          // Light-mode tint in both schemes: a light glyph on #22D3EE would be 1.66:1.
          tintColor: prominent ? light.tint : undefined,
        });
      if (menu)
        list.push({
          type: "menu",
          label: menu.accessibilityLabel,
          accessibilityLabel: menu.accessibilityLabel,
          icon: symbol("more"),
          menu: { items: headerMenuItems(menu.sections) },
        });
      items.unstable_headerRightItems = () => list;
    } else {
      items.headerRight = () => (
        <View className="flex-row items-center">
          {action ? (
            <IconButton
              icon={action.icon}
              accessibilityLabel={action.accessibilityLabel}
              onPress={action.onPress}
              disabled={action.disabled}
            />
          ) : null}
          {menu ? (
            <ActionMenu accessibilityLabel={menu.accessibilityLabel} sections={menu.sections} />
          ) : null}
        </View>
      );
    }
  }
  return (
    <>
      <Stack.Screen
        options={{ ...detailHeaderOptions({ title, scheme, flags, scrolls: scroll }), ...items }}
      />
      <Screen title={title} nativeHeader scroll={scroll} footer={footer} compact={compact}>
        {children}
      </Screen>
    </>
  );
}
