import { Platform } from "react-native";
import { SymbolView } from "expo-symbols";
import { useThemeColor, type ThemeColor } from "heroui-native";
import Svg, { Defs, LinearGradient, Path, Stop } from "react-native-svg";

/** The Gemini sparkle, in its blue-to-rose gradient. */
function GeminiMark({ size }: { size: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Defs>
        <LinearGradient id="gemini" x1="0.1" y1="0.9" x2="0.9" y2="0.1">
          <Stop offset="0" stopColor="#1BA1E3" />
          <Stop offset="0.3" stopColor="#5489D6" />
          <Stop offset="0.6" stopColor="#9B72CB" />
          <Stop offset="1" stopColor="#D96570" />
        </LinearGradient>
      </Defs>
      <Path
        fill="url(#gemini)"
        d="M12 24c0-1.66-.32-3.22-.95-4.68a12.18 12.18 0 0 0-2.58-3.8 12.18 12.18 0 0 0-3.8-2.57A11.7 11.7 0 0 0 0 12c1.66 0 3.22-.32 4.68-.95a12.18 12.18 0 0 0 3.8-2.58 12.18 12.18 0 0 0 2.57-3.8C11.68 3.22 12 1.66 12 0c0 1.66.32 3.22.95 4.68a12.18 12.18 0 0 0 2.58 3.8 12.18 12.18 0 0 0 3.8 2.57c1.45.63 3.01.95 4.67.95-1.66 0-3.22.32-4.68.95a12.18 12.18 0 0 0-3.8 2.58 12.18 12.18 0 0 0-2.57 3.8A11.7 11.7 0 0 0 12 24Z"
      />
    </Svg>
  );
}

/**
 * The mark of the model that runs on this phone: Apple Intelligence on iOS, tinted `color` like
 * the icons beside it, or Gemini in its own gradient on Android.
 */
export function AiMark({ size = 22, color = "foreground" }: { size?: number; color?: ThemeColor }) {
  const tint = useThemeColor(color);
  if (Platform.OS === "ios") {
    return <SymbolView name="apple.intelligence" size={size} tintColor={String(tint)} />;
  }
  return <GeminiMark size={size} />;
}
