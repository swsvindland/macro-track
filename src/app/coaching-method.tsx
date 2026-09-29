import { useState } from "react";
import { Linking } from "react-native";
import { Button, DetailScreen, ErrorText, Heading, Note, Panel } from "@/vector";
import { useStore } from "@/lib/store";
import type { Message } from "@/lib/translations";

// Each section's heading and its paragraph.
const sections: [Message, Message][] = [
  ["coachingProgramTitle", "coachingProgramBody"],
  ["coachingWeightTitle", "coachingWeightBody"],
  ["coachingIntakeTitle", "coachingIntakeBody"],
  ["coachingAdjustTitle", "coachingAdjustBody"],
  ["coachingMacrosTitle", "coachingMacrosBody"],
  ["coachingMaintainTitle", "coachingMaintainBody"],
  ["coachingReviewTitle", "coachingReviewBody"],
  ["coachingScopeTitle", "coachingScopeBody"],
  ["coachingOlderTitle", "coachingOlderBody"],
];
export default function CoachingMethod() {
  const { t } = useStore();
  const [error, setError] = useState("");
  return (
    <DetailScreen title={t("coachingMethodTitle")}>
      <Note>{t("coachingMethodSubtitle")}</Note>
      {sections.map(([title, body]) => (
        <Panel key={title}>
          <Panel.Title>{t(title)}</Panel.Title>
          <Panel.Body>
            <Note>{t(body)}</Note>
          </Panel.Body>
        </Panel>
      ))}
      <Heading level={4}>{t("backgroundReading")}</Heading>
      <Button
        variant="secondary"
        icon="external"
        iconPosition="end"
        onPress={() => {
          void Linking.openURL(
            "https://www.niddk.nih.gov/research-funding/at-niddk/labs-branches/laboratory-biological-modeling/integrative-physiology-section/research/body-weight-planner"
          ).catch(() => setError(t("sourceUnavailable")));
        }}
      >
        {t("niddkSource")}
      </Button>
      <ErrorText message={error} />
    </DetailScreen>
  );
}
