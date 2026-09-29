import { useState } from "react";
import { Linking, View } from "react-native";
import { DetailScreen, ErrorText, Heading, LinkButton, Note, Text } from "@/vector";
import { metricSources } from "@/lib/metric-sources";
import { useStore } from "@/lib/store";

export default function HealthSources() {
  const { t } = useStore();
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
    <DetailScreen title={t("sourcesTitle")}>
      <Note>{t("healthDisclaimer")}</Note>
      {metricSources.map((section) => (
        <View key={section.metric} className="gap-3">
          <Heading level={3}>{t(section.metric)}</Heading>
          <Text>{t(section.method)}</Text>
          {section.references.map((source) => (
            <View key={source.url} className="gap-2">
              <LinkButton
                icon="external"
                accessibilityRole="link"
                accessibilityHint={t("opensInBrowser")}
                onPress={() => void openSource(source.url)}
              >
                {source.title}
              </LinkButton>
              {failedSource === source.url && (
                <>
                  <ErrorText message={t("sourceUnavailable")} />
                  <Text variant="small" tone="muted" selectable>
                    {source.url}
                  </Text>
                </>
              )}
            </View>
          ))}
        </View>
      ))}
    </DetailScreen>
  );
}
