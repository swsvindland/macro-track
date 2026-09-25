import { NativeTabs } from "expo-router/unstable-native-tabs";
import { useThemeColor } from "heroui-native";

export default function TabsLayout() {
  const background = useThemeColor("background");
  const accent = useThemeColor("accent-soft-foreground");
  return (
    <NativeTabs
      tintColor={accent}
      backgroundColor={background}
      labelVisibilityMode="labeled"
      backBehavior="initialRoute"
    >
      <NativeTabs.Trigger
        name="index"
        disableAutomaticContentInsets
        contentStyle={{ backgroundColor: background }}
      >
        <NativeTabs.Trigger.Label>Today</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="fork.knife" md="restaurant" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="progress" contentStyle={{ backgroundColor: background }}>
        <NativeTabs.Trigger.Label>Progress</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="chart.xyaxis.line" md="monitoring" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="plan" contentStyle={{ backgroundColor: background }}>
        <NativeTabs.Trigger.Label>Plan</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="slider.horizontal.3" md="tune" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="library" contentStyle={{ backgroundColor: background }}>
        <NativeTabs.Trigger.Label>Library</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="books.vertical" md="bookmarks" />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
