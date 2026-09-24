import { useStore } from "@/lib/store";
import { NativeTabs } from "expo-router/unstable-native-tabs";
import { useThemeColor } from "heroui-native";
import type { JSX } from "react";

export default function TabsLayout(): JSX.Element {
  const { t } = useStore();
  const background = useThemeColor("background");
  const accent = useThemeColor("link");

  return (
    <NativeTabs
      tintColor={accent}
      backgroundColor={background}
      labelVisibilityMode="labeled"
      backBehavior="initialRoute"
    >
      <NativeTabs.Trigger name="index" contentStyle={{ backgroundColor: background }}>
        <NativeTabs.Trigger.Label>{t("home")}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="scalemass" md="monitor_weight" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="body" contentStyle={{ backgroundColor: background }}>
        <NativeTabs.Trigger.Label>{t("body")}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="figure.stand" md="accessibility_new" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="photos" contentStyle={{ backgroundColor: background }}>
        <NativeTabs.Trigger.Label>{t("photos")}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="photo.on.rectangle" md="photo_library" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="height" contentStyle={{ backgroundColor: background }}>
        <NativeTabs.Trigger.Label>{t("height")}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="arrow.up.and.down" md="height" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="settings" contentStyle={{ backgroundColor: background }}>
        <NativeTabs.Trigger.Label>{t("settings")}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="gearshape" md="settings" />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
