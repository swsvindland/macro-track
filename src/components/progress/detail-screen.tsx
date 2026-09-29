import { useState, type ReactNode } from "react";
import { Pressable, View } from "react-native";
import { Icon, Panel, Text } from "@/vector";

/** A pushed Progress screen: the native bar with the back button, and at most one header action. */
export { DetailScreen } from "@/vector";

/** A short explanation that stays closed until asked for. */
export function Explainer({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <Panel inset="none">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((value) => !value)}
        className="min-h-11 flex-row items-center gap-3 px-4 py-3 active:bg-surface-secondary"
      >
        <Text variant="bodyStrong" className="flex-1">
          {title}
        </Text>
        {/* The registry has one chevron: turned, it reads as "collapse". */}
        <View style={open ? { transform: [{ rotate: "180deg" }] } : undefined}>
          <Icon name="down" size={17} tone="muted" />
        </View>
      </Pressable>
      {open && <View className="gap-2 px-4 pb-4">{children}</View>}
    </Panel>
  );
}
