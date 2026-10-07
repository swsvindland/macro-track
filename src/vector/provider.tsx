import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  AccessibilityInfo,
  I18nManager,
  Platform,
  Text as RNText,
  View,
  useWindowDimensions,
  type AccessibilityState,
  type AccessibilityValue,
  type ViewProps,
} from "react-native";
import { useCalendars, useLocales } from "expo-localization";
import type { HeroUINativeProvider } from "heroui-native";
import { Uniwind, useUniwind } from "uniwind";
import { defaultFlags, type VectorFlags } from "./flags";
import { createFormat, localeTag, type Format } from "./format";
import type { IconSpec } from "./icons";
import { scriptOf, type ScriptClass } from "./script";
import { kitStrings, type KitLanguage, type KitStrings } from "./strings";
import { dark, highContrast, light } from "./tokens";

/** Five haptic events and no others (design-system §7). Default: no-op; the kit never imports expo-haptics. */
export type VectorHaptics = {
  selection: () => void;
  commit: () => void;
  complete: () => void;
  warn: () => void;
  error: () => void;
};
const silentHaptics: VectorHaptics = {
  selection() {},
  commit() {},
  complete() {},
  warn() {},
  error() {},
};

/** Optional icon renderer (expo-symbols SymbolView where installed). Return null to fall back to Ionicons. */
export type VectorIconRenderer = (props: {
  spec: IconSpec;
  size: number;
  color: string;
}) => ReactElement | null;

export type VectorProviderProps = {
  /** The app's resolved language: drives kit strings, script rules and formatting. */
  language: KitLanguage;
  /** Override the Intl tag; default = localeTag(language, device locales). */
  locale?: string;
  /** Override individual kit strings (rarely needed). */
  strings?: Partial<KitStrings>;
  /** Pass a module-level constant: a new object each render re-renders every kit consumer. */
  haptics?: Partial<VectorHaptics>;
  renderIcon?: VectorIconRenderer;
  /** Pass a module-level constant, for the same reason as `haptics`. */
  flags?: Partial<VectorFlags>;
  children: ReactNode;
};

export type VectorKit = {
  language: KitLanguage;
  locale: string;
  script: ScriptClass;
  strings: KitStrings;
  format: Format;
  haptics: VectorHaptics;
  renderIcon?: VectorIconRenderer;
  flags: VectorFlags;
  isRTL: boolean;
  scheme: "light" | "dark";
  /** Accessibility text sizes (fontScale ≥ 1.6): rows stack, Choices become a Select, panel headers stack. */
  largeType: boolean;
  fontScale: number;
  boldText: boolean;
  reduceMotion: boolean;
};

const Ctx = createContext<VectorKit | null>(null);

const web = Platform.OS === "web";

type AccessibilityReads = {
  boldText: (v: boolean) => void;
  reduceMotion: (v: boolean) => void;
  highContrast: (v: boolean) => void;
};

/**
 * Reads and follows Bold Text, Reduce Motion and Increase Contrast from an AccessibilityInfo; returns the cleanup.
 * react-native-web 0.21 has only isReduceMotionEnabled (and listens only for reduceMotionChanged): a missing
 * method is skipped instead of throwing inside the effect, and web stays at regular weight and base contrast.
 * Exported for the node tests (not in the barrel).
 */
export function watchAccessibility(
  info: Pick<typeof AccessibilityInfo, "addEventListener"> & Partial<typeof AccessibilityInfo>,
  set: AccessibilityReads
) {
  let live = true;
  const read = (get: (() => Promise<boolean>) | undefined, apply: (v: boolean) => void) => {
    if (typeof get !== "function") return;
    try {
      void get
        .call(info)
        .then((v) => live && apply(v))
        .catch(() => {});
    } catch {
      // A platform that declares the method but cannot answer: keep the default.
    }
  };
  read(info.isBoldTextEnabled, set.boldText);
  read(info.isReduceMotionEnabled, set.reduceMotion);
  read(info.isDarkerSystemColorsEnabled, set.highContrast);
  const listen = (event: "boldTextChanged" | "reduceMotionChanged" | "darkerSystemColorsChanged", apply: (v: boolean) => void) => {
    try {
      // react-native-web returns undefined for reduceMotionChanged when matchMedia is missing.
      return (info.addEventListener(event, apply) as { remove?: () => void } | undefined) ?? undefined;
    } catch {
      return undefined;
    }
  };
  const subs = [
    listen("boldTextChanged", set.boldText),
    listen("reduceMotionChanged", set.reduceMotion),
    listen("darkerSystemColorsChanged", set.highContrast),
  ];
  return () => {
    live = false;
    for (const sub of subs) sub?.remove?.();
  };
}

/** iOS Bold Text, Reduce Motion and Increase Contrast, kept live (each can change while the app runs). */
function useAccessibilitySettings() {
  const [boldText, setBoldText] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(false);
  const [highContrastOn, setHighContrast] = useState(false);
  useEffect(
    () =>
      watchAccessibility(AccessibilityInfo, {
        boldText: setBoldText,
        reduceMotion: setReduceMotion,
        highContrast: setHighContrast,
      }),
    []
  );
  return { boldText, reduceMotion, highContrastOn };
}

type Announcer = (message: string) => void;
const announcers = new Set<Announcer>();

/**
 * Speaks a message politely, once: VoiceOver / TalkBack through announceForAccessibility; on web (where
 * react-native-web's announceForAccessibility does nothing) through the polite live region the outermost
 * VectorProvider mounts.
 */
export function announce(message: string) {
  if (!message) return;
  if (!web) {
    AccessibilityInfo.announceForAccessibility(message);
    return;
  }
  for (const speak of announcers) speak(message);
}

/**
 * Web only: an off-screen polite live region (aria-live) that `announce` writes to, one per app (the outermost
 * VectorProvider's). A repeated message gets a new key, so the browser announces it again.
 */
function LiveRegion() {
  const [said, setSaid] = useState<{ key: number; message: string } | null>(null);
  useEffect(() => {
    const speak: Announcer = (message) => setSaid((s) => ({ key: (s?.key ?? 0) + 1, message }));
    announcers.add(speak);
    return () => {
      announcers.delete(speak);
    };
  }, []);
  return (
    <View
      aria-live="polite"
      style={{
        position: "absolute",
        width: 1,
        height: 1,
        margin: -1,
        overflow: "hidden",
        opacity: 0,
        pointerEvents: "none",
      }}
    >
      {said ? <RNText key={said.key}>{said.message}</RNText> : null}
    </View>
  );
}

// aria-pressed, aria-current and aria-level are not in React Native's prop types; react-native-web forwards them.
type WebA11y = Pick<
  ViewProps,
  | "aria-busy"
  | "aria-checked"
  | "aria-disabled"
  | "aria-expanded"
  | "aria-selected"
  | "aria-hidden"
  | "aria-valuemax"
  | "aria-valuemin"
  | "aria-valuenow"
  | "aria-valuetext"
> & { "aria-pressed"?: boolean; "aria-current"?: "true"; "aria-level"?: number };
const noWebA11y: WebA11y = Object.freeze({});

/**
 * How `selected` is said on web. ARIA honours aria-selected only on tab, option, row and gridcell roles, so a
 * selected radio, checkbox or switch is `checked` (aria-checked), a selected button is a toggle (`pressed`), a tab
 * or option is `selected`, and anything else (a check row, a menu item, an element with no role) is the `current`
 * item of its set (aria-current, valid on every element).
 */
export type WebSelected = "checked" | "pressed" | "selected" | "current";

/**
 * react-native-web 0.21 maps accessibilityLabel, accessibilityRole and accessibilityLiveRegion, but drops
 * accessibilityState and accessibilityValue. This returns the same facts as aria-* props on web only; on iOS and
 * Android it returns an empty object, so native keeps its accessibility* props as the only source. Spread it next
 * to them; `selectedAs` says how the element's role expresses `selected`. Not part of the barrel.
 */
export function webA11y(
  state?: AccessibilityState | null,
  value?: AccessibilityValue | null,
  selectedAs: WebSelected = "current"
): WebA11y {
  if (!web) return noWebA11y;
  const out: WebA11y = {};
  const selected = state?.selected;
  if (selected !== undefined) {
    if (selectedAs === "selected") out["aria-selected"] = selected;
    else if (selectedAs === "pressed") out["aria-pressed"] = selected;
    else if (selectedAs === "checked") out["aria-checked"] = selected;
    else if (selected) out["aria-current"] = "true";
  }
  if (state?.checked !== undefined) out["aria-checked"] = state.checked;
  if (state?.disabled !== undefined) out["aria-disabled"] = state.disabled;
  if (state?.busy !== undefined) out["aria-busy"] = state.busy;
  if (state?.expanded !== undefined) out["aria-expanded"] = state.expanded;
  if (value?.min !== undefined) out["aria-valuemin"] = value.min;
  if (value?.max !== undefined) out["aria-valuemax"] = value.max;
  if (value?.now !== undefined) out["aria-valuenow"] = value.now;
  if (value?.text !== undefined) out["aria-valuetext"] = value.text;
  return out;
}

/**
 * Hidden from screen readers on web too: react-native-web drops accessibilityElementsHidden and
 * importantForAccessibility, so decoration (glyphs, the pulse block, the meter ticks) needs aria-hidden there.
 */
export const webHidden: WebA11y = web ? Object.freeze({ "aria-hidden": true }) : noWebA11y;

const webLevels = [1, 2, 3, 4, 5, 6].map((level) => Object.freeze({ "aria-level": level }));
/**
 * A header's outline level on web: react-native-web renders `accessibilityRole="header"` as h1 unless aria-level
 * says otherwise. Empty on iOS and Android (and for no level). Not part of the barrel.
 */
export const webHeading = (level?: number): WebA11y =>
  web && level ? (webLevels[level - 1] ?? noWebA11y) : noWebA11y;

/** The part of a DOM keyboard event the kit reads (react-native-web hands View a React KeyboardEvent). */
export type WebKeyEvent = { key: string; preventDefault: () => void };
type WebKeys = { tabIndex?: 0; onKeyDown?: (event: WebKeyEvent) => void };
const noWebKeys: WebKeys = Object.freeze({});
/**
 * Web only: a tab stop with a key handler (react-native-web drops accessibilityActions, so an adjustable control
 * needs its keys). `onKey` returns true for a key it used, which then does not scroll the page. Empty on iOS and
 * Android, where the accessibility actions are the way in. Not part of the barrel.
 */
export const webKeys = (onKey: (key: string) => boolean): WebKeys =>
  web
    ? {
        tabIndex: 0,
        onKeyDown: (event) => {
          if (onKey(event.key)) event.preventDefault();
        },
      }
    : noWebKeys;

/** Maps a highContrast CSS key ("--accent-soft-foreground") to its base token ("accentSoftForeground"). */
const tokenKey = (cssVar: string) =>
  cssVar.slice(2).replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase()) as keyof typeof light;

export function VectorProvider({
  language,
  locale,
  strings,
  haptics,
  renderIcon,
  flags,
  children,
}: VectorProviderProps) {
  // A provider nested in another (the gallery's language switch) leaves the live region to the outer one, so web
  // announces each message once.
  const outer = useContext(Ctx);
  const { fontScale } = useWindowDimensions();
  const { theme } = useUniwind();
  const scheme: "light" | "dark" = theme === "dark" ? "dark" : "light";
  const { boldText, reduceMotion, highContrastOn } = useAccessibilitySettings();
  const device = useLocales();
  const uses24h = useCalendars()[0]?.uses24hourClock ?? undefined;
  const tag = locale ?? localeTag(language, device);
  const merged = useMemo<VectorFlags>(() => ({ ...defaultFlags, ...flags }), [flags]);

  // Increase Contrast for RN content. Flagged off until verified on device; native chrome adapts already.
  const contrastSwap = merged.runtimeContrastSwap;
  useEffect(() => {
    if (!contrastSwap) return;
    for (const mode of ["light", "dark"] as const) {
      const base = mode === "dark" ? dark : light;
      const hc: Record<string, string> = highContrast[mode];
      const vars = Object.fromEntries(
        Object.keys(hc).map((k) => [k, highContrastOn ? hc[k] : base[tokenKey(k)]])
      );
      Uniwind.updateCSSVariables(mode, vars);
    }
  }, [highContrastOn, contrastSwap]);

  const value = useMemo<VectorKit>(() => {
    // English under every language so a key can never render empty, even for a language the kit lacks.
    const words: KitStrings = { ...kitStrings.en, ...kitStrings[language], ...strings };
    return {
      language,
      locale: tag,
      script: scriptOf(language),
      strings: words,
      // The formatter reads the kit's unit symbols and list templates in the same language.
      format: createFormat(tag, { uses24h, strings: words }),
      haptics: { ...silentHaptics, ...haptics },
      renderIcon,
      flags: merged,
      // Direction is fixed for the process: a change needs a reload (design-system §9.1).
      isRTL: I18nManager.isRTL,
      scheme,
      largeType: fontScale >= 1.6,
      fontScale,
      boldText,
      reduceMotion,
    };
  }, [
    language,
    tag,
    strings,
    uses24h,
    haptics,
    renderIcon,
    merged,
    scheme,
    fontScale,
    boldText,
    reduceMotion,
  ]);
  return (
    <Ctx.Provider value={value}>
      {children}
      {web && !outer ? <LiveRegion /> : null}
    </Ctx.Provider>
  );
}

export function useKit(): VectorKit {
  const v = useContext(Ctx);
  if (!v) {
    throw new Error(
      "VectorProvider is required (src/vector-adapter.tsx). Mount VectorAdapter outside HeroUINativeProvider, so overlays in HeroUI's portal host sit inside it (design-system §5)."
    );
  }
  return v;
}
/** For kit hooks that must also work before the provider mounts (motion). Not part of the barrel. */
export const useOptionalKit = () => useContext(Ctx);

/**
 * Re-provides the kit inside a HeroUI portal (menus, selects, calendars). Portal content renders at HeroUI's
 * PortalHost, beside HeroUINativeProvider's children, so with the providers nested the other way round a kit
 * Icon or Label there would find no VectorProvider. Kit components pass the value they read at the trigger.
 * Not part of the barrel.
 */
export const KitScope = ({ value, children }: { value: VectorKit; children: ReactNode }) => (
  <Ctx.Provider value={value}>{children}</Ctx.Provider>
);
export const useKitStrings = () => useKit().strings;
export const useKitFormat = () => useKit().format;
export const useScript = () => useKit().script;
export const useHaptics = () => useKit().haptics;
/** Pagers invert their gesture delta with this (water home-carousel, macro week-strip). */
export const useIsRTL = () => useKit().isRTL;

/** Pass to <HeroUINativeProvider config={vectorHeroConfig}>. Same object in all four apps. */
export const vectorHeroConfig: ComponentProps<typeof HeroUINativeProvider>["config"] = {
  textProps: { maxFontSizeMultiplier: 2 },
  textInputProps: { maxFontSizeMultiplier: 1.6 },
};

type Budget = { register: () => () => void };
const BudgetCtx = createContext<Budget | null>(null);

/**
 * Per-screen signal budget (design-system §1.5, §5.3): Screen and Editor wrap their content in this. Every
 * primary Button / IconButton registers while mounted; a second live registration warns in development only.
 */
export function SignalBudget({ name, children }: { name?: string; children: ReactNode }) {
  const count = useRef(0);
  const budget = useMemo<Budget>(
    () => ({
      register() {
        count.current += 1;
        if (__DEV__ && count.current > 1) {
          console.warn(
            `[vector] ${count.current} primary actions on one ${name ?? "screen"}; the system allows one (design-system §5.3).`
          );
        }
        return () => {
          count.current -= 1;
        };
      },
    }),
    [name]
  );
  return <BudgetCtx.Provider value={budget}>{children}</BudgetCtx.Provider>;
}

/** Registers one primary action with the nearest SignalBudget while `active` (no-op outside one). */
export function useSignalBudget(active: boolean) {
  const budget = useContext(BudgetCtx);
  useEffect(() => (active && budget ? budget.register() : undefined), [active, budget]);
}

/**
 * The PortalHost of the Editor sheet a control sits in, so DateInput, TimeInput, Select and menus open above the
 * sheet. Lives here, not in editor.tsx, so form and list controls never import the Editor (no import cycle).
 */
export const EditorPortalContext = createContext<string | undefined>(undefined);
export const useEditorPortalHost = () => useContext(EditorPortalContext);

/**
 * True inside a selected SignalCell (form.tsx): kit Text, Value and Icon there draw signal ink (#071017) whatever
 * tone they pass, so a signal fill never carries another content colour (design-system §2.4, §5.5). App marks drawn
 * in a cell (lift's effort bars) read `useSignalInk()` to pick their ink. Lives here, not in form.tsx, so text and
 * icon never import the form module (no import cycle).
 */
export const SignalInkContext = createContext(false);
export const useSignalInk = () => useContext(SignalInkContext);
