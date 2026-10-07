import { useFonts } from "expo-font";
import { Ionicons } from "@expo/vector-icons";
import { useEffect, useState, type JSX } from "react";
import { ScrollView } from "react-native";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { getLocales } from "expo-localization";
import { HeroUINativeProvider } from "heroui-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useMigrations } from "drizzle-orm/expo-sqlite/migrator";
import migrations from "../../drizzle/migrations";
import {
  Button,
  ErrorText,
  NavigationTheme,
  Note,
  SystemState,
  VectorProvider,
  vectorHeroConfig,
} from "@/vector";
import { VectorAdapter } from "@/vector-adapter";
import { StoreProvider } from "@/lib/store";
import { db } from "@/db";
import { shareDatabaseCopy } from "@/lib/data-files";
import { NutritionProvider } from "@/lib/nutrition-store";
import { resolveLanguage, translate, type Language } from "@/lib/translations";
import { VaultRoot } from "@/vault";

import "../global.css";

// The splash stays up until fonts and migrations are ready, so there is no loading screen in
// between.
void SplashScreen.preventAutoHideAsync();
SplashScreen.setOptions({ duration: 200, fade: true });

function MigrationError({ language, message }: { language: Language; message: string }) {
  const insets = useSafeAreaInsets();
  const [sharing, setSharing] = useState(false);
  const [shareError, setShareError] = useState("");
  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerStyle={{
        padding: 16,
        paddingTop: insets.top + 16,
        paddingBottom: insets.bottom + 16,
        gap: 16,
        width: "100%",
        maxWidth: 672,
        alignSelf: "center",
      }}
    >
      <SystemState kind="error" code={translate(language, "migrationError")} message={message} />
      <Note>{translate(language, "migrationSafe")}</Note>
      <Button
        variant="secondary"
        className="self-start"
        disabled={sharing}
        onPress={() => {
          setSharing(true);
          setShareError("");
          shareDatabaseCopy()
            .catch((e) =>
              setShareError(
                e instanceof Error ? e.message : translate(language, "shareDatabaseFailed")
              )
            )
            .finally(() => setSharing(false));
        }}
      >
        {translate(language, "shareDatabaseCopy")}
      </Button>
      <ErrorText message={shareError} />
    </ScrollView>
  );
}

export default function RootLayout(): JSX.Element | null {
  const [fontsLoaded, fontError] = useFonts({
    Inter: require("../../assets/fonts/Inter.ttf"),
    IBMPlexMono: require("../../assets/fonts/IBMPlexMono-Regular.ttf"),
    // Home's icon-only controls must not render blank on a cold start.
    ...Ionicons.font,
  });
  const { success, error } = useMigrations(db, migrations);
  const fontsReady = fontsLoaded || !!fontError;
  const ready = (success || !!error) && fontsReady;
  // Effects run after the tree below has mounted, so the store's first read is done before the
  // splash goes.
  useEffect(() => {
    if (ready) void SplashScreen.hideAsync();
  }, [ready]);

  if (!ready) return null;

  if (error) {
    // Before the store opens, so it follows the device language rather than the saved preference.
    const language = resolveLanguage("system", getLocales()[0]?.languageCode);
    return (
      <GestureHandlerRootView style={{ flex: 1 }}>
        <VectorProvider language={language}>
          <HeroUINativeProvider config={vectorHeroConfig}>
            <MigrationError language={language} message={error.message} />
            <StatusBar style="auto" />
          </HeroUINativeProvider>
        </VectorProvider>
      </GestureHandlerRootView>
    );
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <StoreProvider>
        {/* Above HeroUI's portal host: menus, selects and calendars render kit parts there. */}
        <VectorAdapter>
          <HeroUINativeProvider config={vectorHeroConfig}>
            <NutritionProvider>
              {/* React Navigation's own palette would paint pushed screens and headers light. */}
              <NavigationTheme>
                <Stack screenOptions={{ headerShown: false }}>
                  <Stack.Screen name="(tabs)" />
                </Stack>
              </NavigationTheme>
              {/* Inside NutritionProvider: a restore refreshes the diary through it. */}
              <VaultRoot />
            </NutritionProvider>
            <StatusBar style="auto" />
          </HeroUINativeProvider>
        </VectorAdapter>
      </StoreProvider>
    </GestureHandlerRootView>
  );
}
