import { NativeTabs } from "expo-router/unstable-native-tabs";
import { DockProvider, tabOptions, useKit } from "@/vector";
import { useStore } from "@/lib/store";

/** The system draws the bar (Liquid Glass on iOS 26); only its tint and the triggers are ours. */
export default function TabsLayout() {
  const { scheme } = useKit();
  const { t } = useStore();
  return (
    <DockProvider>
      <NativeTabs {...tabOptions(scheme)}>
        <NativeTabs.Trigger name="index">
          <NativeTabs.Trigger.Label>{t("today")}</NativeTabs.Trigger.Label>
          <NativeTabs.Trigger.Icon sf="fork.knife" md="restaurant" />
        </NativeTabs.Trigger>
        <NativeTabs.Trigger name="plan">
          <NativeTabs.Trigger.Label>{t("plan")}</NativeTabs.Trigger.Label>
          <NativeTabs.Trigger.Icon sf="slider.horizontal.3" md="tune" />
        </NativeTabs.Trigger>
        <NativeTabs.Trigger name="progress">
          <NativeTabs.Trigger.Label>{t("progress")}</NativeTabs.Trigger.Label>
          <NativeTabs.Trigger.Icon sf="chart.xyaxis.line" md="monitoring" />
        </NativeTabs.Trigger>
        <NativeTabs.Trigger name="library">
          <NativeTabs.Trigger.Label>{t("library")}</NativeTabs.Trigger.Label>
          <NativeTabs.Trigger.Icon
            sf={{ default: "books.vertical", selected: "books.vertical.fill" }}
            md="bookmarks"
          />
        </NativeTabs.Trigger>
        <NativeTabs.Trigger name="settings">
          <NativeTabs.Trigger.Label>{t("settings")}</NativeTabs.Trigger.Label>
          <NativeTabs.Trigger.Icon
            sf={{ default: "gearshape", selected: "gearshape.fill" }}
            md="settings"
          />
        </NativeTabs.Trigger>
      </NativeTabs>
    </DockProvider>
  );
}
