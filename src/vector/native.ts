import { DynamicColorIOS, Platform, type ColorValue } from "react-native";
import { DarkTheme, DefaultTheme, type NativeStackNavigationOptions, type Theme } from "expo-router";
import type { NativeTabsProps } from "expo-router/unstable-native-tabs";
import { dark, highContrast, light } from "./tokens";
import type { VectorFlags } from "./flags";

/** iOS 26+ (Liquid Glass chrome). Never isLiquidGlassAvailable(): expo-glass-effect is not installed. */
export const isLiquidGlass = Platform.OS === "ios" && parseInt(String(Platform.Version), 10) >= 26;

type Scheme = "light" | "dark";

function adaptive(name: "tint" | "foreground", scheme: Scheme): ColorValue {
  if (Platform.OS === "ios") {
    return DynamicColorIOS({
      light: light[name],
      dark: dark[name],
      highContrastLight: highContrast.light[`--${name}`],
      highContrastDark: highContrast.dark[`--${name}`],
    });
  }
  return scheme === "dark" ? dark[name] : light[name];
}

/** Text-safe cyan for native chrome (tab tint, header tint, switches). */
export const nativeTint = (scheme: Scheme) => adaptive("tint", scheme);
export const nativeForeground = (scheme: Scheme) => adaptive("foreground", scheme);

/**
 * React Navigation's theme in Vector colours (mounted by `NavigationTheme`). Without it, native-stack falls back to
 * its own palette wherever an option is unset: a white `card` header bar and a grey or near-black screen background.
 */
export function navigationTheme(scheme: Scheme): Theme {
  const t = scheme === "dark" ? dark : light;
  const base = scheme === "dark" ? DarkTheme : DefaultTheme;
  return {
    ...base,
    colors: {
      primary: t.tint,
      background: t.background,
      card: t.background,
      text: t.foreground,
      border: t.border,
      notification: t.danger,
    },
  };
}

/**
 * Props for <NativeTabs>. iOS: no background/blur/shadow so Liquid Glass renders; the tint colours only the
 * selected item. Android: Material bar on surface, the selected indicator is the icon look (signal fill, signal-ink glyph).
 */
export function tabOptions(
  scheme: Scheme
): Pick<
  NativeTabsProps,
  | "tintColor"
  | "minimizeBehavior"
  | "labelVisibilityMode"
  | "backBehavior"
  | "backgroundColor"
  | "indicatorColor"
  | "iconColor"
  | "rippleColor"
> {
  const t = scheme === "dark" ? dark : light;
  if (Platform.OS === "android") {
    return {
      tintColor: t.foreground,
      backgroundColor: t.surface,
      indicatorColor: t.accent,
      iconColor: { default: t.muted, selected: t.accentForeground },
      rippleColor: t.surfaceTertiary,
      labelVisibilityMode: "labeled",
      backBehavior: "initialRoute",
    };
  }
  return { tintColor: nativeTint(scheme), minimizeBehavior: "never" };
}

/** Options for every pushed screen (native bar, system title, no in-content title). */
export function detailHeaderOptions(args: {
  title: string;
  scheme: Scheme;
  flags: Pick<VectorFlags, "transparentHeaders">;
  /** Non-scrolling screens must not sit under a transparent header. */
  scrolls?: boolean;
}): NativeStackNavigationOptions {
  const t = args.scheme === "dark" ? dark : light;
  const transparent = isLiquidGlass && args.flags.transparentHeaders && args.scrolls !== false;
  return {
    headerShown: true,
    title: args.title,
    headerTransparent: transparent,
    // iOS 26: never paint the bar (Liquid Glass): transparent, so the canvas shows behind the glass items. Unset
    // would fall back to the navigation theme's card colour. Below 26 and Android: opaque canvas, as today.
    headerStyle: { backgroundColor: isLiquidGlass ? "transparent" : t.background },
    headerShadowVisible: false,
    headerLargeTitleEnabled: false,
    headerBackButtonDisplayMode: "minimal",
    headerTintColor: nativeForeground(args.scheme) as string,
    contentStyle: { backgroundColor: t.background },
  };
}

/** Read-only explainers presented as formSheet routes (LATER: only where the route already exists). */
export function sheetOptions(scheme: Scheme): NativeStackNavigationOptions {
  const t = scheme === "dark" ? dark : light;
  return {
    presentation: "formSheet",
    sheetAllowedDetents: "fitToContents",
    sheetGrabberVisible: true,
    headerShown: false,
    contentStyle: { backgroundColor: isLiquidGlass ? "transparent" : t.surface },
  };
}
