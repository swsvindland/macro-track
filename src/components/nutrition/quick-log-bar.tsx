import { useEffect, useState } from "react";
import { AppState, Keyboard, Platform, View } from "react-native";
import { router } from "expo-router";
import { IconButton, ScreenFooter, SearchTrigger } from "@/vector";
import { requestAppAction, type AppAction } from "@/lib/app-actions";
import { modelStatus, type ModelStatus } from "@/lib/local-ai";
import { useStore } from "@/lib/store";
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
 * The docked strip above the tab bar: the search row opens the logger ready to type, the
 * analysis mark the photo or description logger where this phone can run it, and the barcode
 * button (the screen's one primary action) the scanner.
 */
export function QuickLogBar({
  label,
  ai,
  onAction,
}: {
  /** Names the day on screen when it isn't today. */
  label?: string;
  ai: ModelStatus | null;
  onAction: (action: QuickLogAction) => void;
}) {
  const { t } = useStore();
  const keyboard = useKeyboardShown();
  if (keyboard) return null;
  const search = label ?? t("searchForFood");
  return (
    <ScreenFooter>
      {/* A field-look button, not a field: it opens the logger's own search. */}
      <View className="min-w-0 flex-1">
        <SearchTrigger label={search} onPress={() => onAction("search")} />
      </View>
      {photoLoggingOffered(ai) && (
        <IconButton
          icon="analysis"
          variant="secondary"
          tone="tint"
          accessibilityLabel={ai?.vision ? t("logMealFromPhoto") : t("describeMealToLog")}
          onPress={() => onAction("photo")}
        />
      )}
      <IconButton
        icon="scan"
        variant="primary"
        accessibilityLabel={t("scanBarcode")}
        onPress={() => onAction("scan")}
      />
    </ScreenFooter>
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
