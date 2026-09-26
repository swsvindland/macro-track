import { useState, type ReactNode } from "react";
import { View } from "react-native";
import { Stack } from "expo-router";
import { useThemeColor } from "heroui-native";
import { SystemButton, SystemIcon, SystemPanel, SystemText as Text } from "@/components/system";
import { Screen } from "@/components/ui";

/** A pushed Progress screen with the native back button and optional header action. */
export function DetailScreen({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  const [background, foreground] = useThemeColor(["background", "foreground"]);
  return (
    <Screen title={title} nativeHeader>
      <Stack.Screen
        options={{
          headerShown: true,
          title,
          headerBackButtonDisplayMode: "minimal",
          headerStyle: { backgroundColor: background },
          headerTintColor: foreground,
          headerShadowVisible: false,
          contentStyle: { backgroundColor: background },
          headerRight: action ? () => action : undefined,
        }}
      />
      {children}
    </Screen>
  );
}

/** A short explanation that stays closed until asked for. */
export function Explainer({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <SystemPanel className="p-2">
      <SystemButton
        variant="ghost"
        className="justify-start px-3"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((value) => !value)}
      >
        <SystemIcon name="bulb-outline" size={18} color="muted" />
        <Text className="flex-1 font-semibold">{title}</Text>
        <SystemIcon name={open ? "chevron-up" : "chevron-down"} size={16} color="muted" />
      </SystemButton>
      {open && <View className="gap-2 px-3 pb-3">{children}</View>}
    </SystemPanel>
  );
}
