import { Ionicons } from "@expo/vector-icons";
import { useThemeColor } from "heroui-native";
import { icons, type IconName, type IconSpec } from "./icons";
import { useKit, useSignalInk, webHidden } from "./provider";

export type IconTone =
  "foreground" | "muted" | "tint" | "onSignal" | "onDanger" | "danger" | "warning" | "success";
/** 12 = Choices check slot, 17 = Button / ActionMenu glyph, 20 = default, 16/24 = dense / hero. */
export type IconSize = 12 | 16 | 17 | 20 | 24;
// `link` is HeroUI's registered alias of --tint, so the text-safe cyan reaches glyphs without a new ThemeColor.
const toneToken = {
  foreground: "foreground",
  muted: "muted",
  tint: "link",
  onSignal: "accent-foreground",
  /** Glyph on a danger fill (destructive swipe panel): white in light, signal ink in dark. */
  onDanger: "danger-foreground",
  danger: "danger",
  warning: "warning",
  success: "success",
} as const;

/**
 * Semantic icon. Size follows Dynamic Type (× min(fontScale, 1.5)); directional glyphs mirror in RTL. Inside a
 * selected SignalCell it is signal ink whatever `tone` it is given (useSignalInk).
 */
export function Icon({
  name,
  size = 20,
  tone = "foreground",
}: {
  name: IconName;
  size?: IconSize;
  tone?: IconTone;
}) {
  const { renderIcon, fontScale, isRTL } = useKit();
  const ink = useSignalInk();
  const color = String(useThemeColor(toneToken[ink ? "onSignal" : tone]));
  const spec: IconSpec = icons[name];
  const px = Math.round(size * Math.min(Math.max(fontScale, 1), 1.5));
  const custom = renderIcon?.({ spec, size: px, color });
  if (custom) return custom;
  return (
    <Ionicons
      name={spec.ion}
      size={px}
      color={color}
      style={spec.mirrors && isRTL ? { transform: [{ scaleX: -1 }] } : undefined}
      accessibilityElementsHidden
      importantForAccessibility="no"
      {...webHidden}
    />
  );
}
