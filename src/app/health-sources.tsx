import { useState } from "react";
import { Linking, View } from "react-native";
import { Stack } from "expo-router";
import { useThemeColor } from "heroui-native";
import { Screen } from "@/components/ui";
import { SystemButton, SystemText as Text } from "@/components/system";
import { metricSources } from "@/lib/metric-sources";
import { useStore } from "@/lib/store";

export default function HealthSources() {
  const { t } = useStore();
  const background = useThemeColor("background");
  const foreground = useThemeColor("foreground");
  const [failedSource, setFailedSource] = useState<string | null>(null);

  async function openSource(url: string) {
    setFailedSource(null);
    try {
      await Linking.openURL(url);
    } catch {
      setFailedSource(url);
    }
  }

  return (
    <Screen title={t("sourcesTitle")} nativeHeader>
      <Stack.Screen
        options={{
          headerShown: true,
          title: t("sourcesTitle"),
          headerBackButtonDisplayMode: "minimal",
          headerStyle: { backgroundColor: background },
          headerTintColor: foreground,
          contentStyle: { backgroundColor: background },
        }}
      />
      <Text className="text-muted">{t("healthDisclaimer")}</Text>
      {metricSources.map((section) => (
        <View key={section.metric} className="gap-3">
          <Text accessibilityRole="header" className="text-xl font-semibold">
            {t(section.metric)}
          </Text>
          <Text>{t(section.method)}</Text>
          {section.references.map((source) => (
            <View key={source.url} className="gap-2">
              <SystemButton
                variant="ghost"
                accessibilityRole="link"
                accessibilityLabel={source.title}
                className="justify-start"
                onPress={() => void openSource(source.url)}
              >
                <Text className="flex-1 text-link underline">{source.title}</Text>
              </SystemButton>
              {failedSource === source.url && (
                <>
                  <Text accessibilityRole="alert" className="text-danger">
                    {t("sourceUnavailable")}
                  </Text>
                  <Text selectable className="text-sm text-muted">
                    {source.url}
                  </Text>
                </>
              )}
            </View>
          ))}
        </View>
      ))}
    </Screen>
  );
}
