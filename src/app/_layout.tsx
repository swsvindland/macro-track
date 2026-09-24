import { useFonts } from "expo-font";
import { useUniwind } from "uniwind";
import type { JSX } from "react";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { HeroUINativeProvider } from "heroui-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { ActivityIndicator, Text, View } from "react-native";
import { useMigrations } from "drizzle-orm/expo-sqlite/migrator";
import migrations from "../../drizzle/migrations";
import { StoreProvider } from "@/lib/store";
import { db } from "@/db";

import "../global.css";

function ThemedStatusBar() {
  const { theme } = useUniwind();
  return <StatusBar style={theme === "dark" ? "light" : "dark"} />;
}

export default function RootLayout(): JSX.Element {
  const [fontsLoaded, fontError] = useFonts({
    Inter: require("../../assets/fonts/Inter.ttf"),
    IBMPlexMono: require("../../assets/fonts/IBMPlexMono-Regular.ttf"),
  });
  const { success, error } = useMigrations(db, migrations);

  if (error) {
    return (
      <View className="flex-1 items-center justify-center bg-background p-6">
        <Text className="text-center text-base text-danger">Migration error: {error.message}</Text>
      </View>
    );
  }

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
          <Stack screenOptions={{ headerShown: false }}>
            <Stack.Screen name="(tabs)" />
          </Stack>
        </StoreProvider>
        <ThemedStatusBar />
      </HeroUINativeProvider>
    </GestureHandlerRootView>
  );
}
