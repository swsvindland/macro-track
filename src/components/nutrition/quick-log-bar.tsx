import { useEffect, useState } from "react";
import { AppState, Keyboard, Platform, View } from "react-native";
import { router } from "expo-router";
import {
  SystemButton,
  SystemIcon,
  SystemIconButton,
  SystemText as Text,
} from "@/components/system";
import { requestAppAction, type AppAction } from "@/lib/app-actions";
import { modelStatus, type ModelStatus } from "@/lib/local-ai";
import { AiMark } from "./ai-mark";
import { photoLoggingOffered } from "./photo-logger";

export type QuickLogAction = Extract<AppAction, "search" | "scan" | "photo">;

// The last status read on Progress or Plan, so the other tab's bar doesn't reflow on first visit.
let known: ModelStatus | null = null;

/** Hides the bar with the keyboard, which would otherwise lift it over the field on Android. */
function useKeyboardShown() {
  const [shown, setShown] = useState(() => Keyboard.isVisible());
  useEffect(() => {
    const ios = Platform.OS === "ios";
    const subs = [
      Keyboard.addListener(ios ? "keyboardWillShow" : "keyboardDidShow", () => setShown(true)),
      Keyboard.addListener(ios ? "keyboardWillHide" : "keyboardDidHide", () => setShown(false)),
    ];
    return () => subs.forEach((sub) => sub.remove());
  }, []);
  return shown;
}

/**
 * Pinned above the tab bar: the pill opens the logger ready to search, the AI mark the photo or
 * description logger where this phone can run it, and the barcode button the scanner.
 */
export function QuickLogBar({
  label = "Search for a food",
  ai,
  onAction,
}: {
  /** Names the day on screen when it isn't today. */
  label?: string;
  ai: ModelStatus | null;
  onAction: (action: QuickLogAction) => void;
}) {
  const keyboard = useKeyboardShown();
  if (keyboard) return null;
  return (
    <View className="flex-row items-center gap-2">
      <View className="flex-1 flex-row items-center rounded-full border border-border bg-overlay shadow-overlay">
        <SystemButton
          variant="ghost"
          className="min-h-12 flex-1 justify-start gap-3 rounded-full px-4"
          accessibilityLabel={label}
          onPress={() => onAction("search")}
        >
          <SystemIcon name="search" size={20} color="muted" />
          <Text numberOfLines={1} maxFontSizeMultiplier={1.3} className="shrink text-muted">
            {label}
          </Text>
        </SystemButton>
      </View>
      {photoLoggingOffered(ai) && (
        <View className="rounded-full border border-border bg-overlay shadow-overlay">
          <SystemIconButton
            icon={<AiMark />}
            className="h-12 w-12 min-w-12"
            accessibilityLabel={
              ai?.vision ? "Log a meal from a photo" : "Describe a meal to log it"
            }
            onPress={() => onAction("photo")}
          />
        </View>
      )}
      <View className="rounded-full shadow-overlay">
        <SystemIconButton
          icon="barcode-outline"
          variant="primary"
          iconSize={24}
          className="h-12 w-12 min-w-12"
          accessibilityLabel="Scan barcode"
          onPress={() => onAction("scan")}
        />
      </View>
    </View>
  );
}

/** The bar on Progress and Plan: each button opens its sheet on Today, logging to today. */
export function TabQuickLogBar() {
  const [ai, setAi] = useState(known);
  useEffect(() => {
    let active = true;
    // Apple Intelligence may be turned on, or Gemini Nano finish installing, while away.
    const read = () => {
      void modelStatus().then((status) => {
        known = status;
        if (active) setAi(status);
      });
    };
    read();
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") read();
    });
    return () => {
      active = false;
      sub.remove();
    };
  }, []);
  return (
    <QuickLogBar
      ai={ai}
      onAction={(action) => {
        // Home's sheets are shown over Today, so the tab changes first.
        router.navigate("/");
        requestAppAction(action);
      }}
    />
  );
}
