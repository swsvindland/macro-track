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
import { AccessibilityInfo, I18nManager, useWindowDimensions } from "react-native";
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

/** iOS Bold Text, Reduce Motion and Increase Contrast, kept live (each can change while the app runs). */
function useAccessibilitySettings() {
  const [boldText, setBoldText] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(false);
  const [highContrastOn, setHighContrast] = useState(false);
  useEffect(() => {
    let live = true;
    const read = (get: () => Promise<boolean>, set: (v: boolean) => void) =>
      void get()
        .then((v) => live && set(v))
        .catch(() => {});
    read(AccessibilityInfo.isBoldTextEnabled, setBoldText);
    read(AccessibilityInfo.isReduceMotionEnabled, setReduceMotion);
    read(AccessibilityInfo.isDarkerSystemColorsEnabled, setHighContrast);
    const subs = [
      AccessibilityInfo.addEventListener("boldTextChanged", setBoldText),
      AccessibilityInfo.addEventListener("reduceMotionChanged", setReduceMotion),
      AccessibilityInfo.addEventListener("darkerSystemColorsChanged", setHighContrast),
    ];
    return () => {
      live = false;
      subs.forEach((s) => s.remove());
    };
  }, []);
  return { boldText, reduceMotion, highContrastOn };
}

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
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
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
