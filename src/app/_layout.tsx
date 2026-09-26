import { useFonts } from "expo-font";
import { Ionicons } from "@expo/vector-icons";
import { useUniwind } from "uniwind";
import { useState, type JSX } from "react";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { HeroUINativeProvider } from "heroui-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { useMigrations } from "drizzle-orm/expo-sqlite/migrator";
import migrations from "../../drizzle/migrations";
import { StoreProvider } from "@/lib/store";
import { db } from "@/db";
import { shareDatabaseCopy } from "@/lib/data-files";
import { NutritionProvider } from "@/lib/nutrition-store";

import "../global.css";

function MigrationError({ message }: { message: string }) {
  const [sharing, setSharing] = useState(false);
  const [shareError, setShareError] = useState("");
  return (
    <View className="flex-1 items-center justify-center gap-4 bg-background p-6">
      <Text className="text-center text-base text-danger">Migration error: {message}</Text>
      <Text className="text-center text-sm text-muted">
        Your records were not changed. Save a copy to keep them safe.
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: sharing }}
        disabled={sharing}
        className="min-h-11 justify-center rounded-2xl bg-accent px-4 py-3"
        onPress={() => {
          setSharing(true);
          setShareError("");
          shareDatabaseCopy()
            .catch((e) =>
              setShareError(e instanceof Error ? e.message : "Could not share the database.")
            )
            .finally(() => setSharing(false));
        }}
      >
        <Text className="text-base font-semibold text-accent-foreground">Share database copy</Text>
      </Pressable>
      {!!shareError && (
        <Text accessibilityLiveRegion="polite" className="text-center text-sm text-danger">
          {shareError}
        </Text>
      )}
    </View>
  );
}

function ThemedStatusBar() {
  const { theme } = useUniwind();
  return <StatusBar style={theme === "dark" ? "light" : "dark"} />;
}

export default function RootLayout(): JSX.Element {
  const [fontsLoaded, fontError] = useFonts({
    Inter: require("../../assets/fonts/Inter.ttf"),
    IBMPlexMono: require("../../assets/fonts/IBMPlexMono-Regular.ttf"),
    // Home's icon-only controls must not render blank on a cold start.
    ...Ionicons.font,
  });
  const { success, error } = useMigrations(db, migrations);

  if (error) return <MigrationError message={error.message} />;

  if (!success || (!fontsLoaded && !fontError)) {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <ActivityIndicator size="large" />
      </View>
    );
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <HeroUINativeProvider>
        <StoreProvider>
          <NutritionProvider>
            <Stack screenOptions={{ headerShown: false }}>
              <Stack.Screen name="(tabs)" />
            </Stack>
          </NutritionProvider>
        </StoreProvider>
        <ThemedStatusBar />
      </HeroUINativeProvider>
    </GestureHandlerRootView>
  );
}
